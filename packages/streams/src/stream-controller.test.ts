import { describe, expect, it } from 'vitest';
import { StreamController, type StreamStatus } from './stream-controller.js';

/** A sleep that resolves immediately, so backoff does not slow the suite. */
const instantSleep = async (_ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
};

/** Yield to the microtask queue until `pred` holds or the budget runs out. */
async function until(pred: () => boolean, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks && !pred(); i++) await Promise.resolve();
  if (!pred()) throw new Error('condition not reached');
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

describe('StreamController', () => {
  it('delivers messages and reports live', async () => {
    const seen: number[] = [];
    const states: StreamStatus[] = [];
    const c = new StreamController<number>({
      label: 'test',
      request: undefined,
      open: () => fromArray([1, 2, 3]),
      onMessage: (m) => seen.push(m),
      onStateChange: (s) => states.push(s.status),
      sleep: instantSleep,
      random: () => 0.5,
    });

    c.start();
    await until(() => seen.length === 3);
    await c.stop();

    expect(seen).toEqual([1, 2, 3]);
    expect(states[0]).toBe('connecting');
    expect(states).toContain('live');
    expect(c.getState().msgCount).toBe(3);
  });

  it('reconnects after a drop and resets attempt once a message lands', async () => {
    let opens = 0;
    const seen: number[] = [];
    const c = new StreamController<number>({
      label: 'flaky',
      request: undefined,
      open: () => {
        opens++;
        if (opens === 1) throw new Error('connection refused');
        return fromArray([42]);
      },
      onMessage: (m) => seen.push(m),
      sleep: instantSleep,
      random: () => 0.5,
    });

    c.start();
    await until(() => seen.length === 1);
    await c.stop();

    expect(opens).toBeGreaterThanOrEqual(2);
    // A delivered message proves liveness, so the backoff counter is cleared.
    expect(c.getState().attempt).toBe(0);
    expect(c.getState().lastError).toBeUndefined();
  });

  it('stops retrying on a fatal error', async () => {
    let opens = 0;
    const c = new StreamController<number>({
      label: 'ejected',
      request: undefined,
      open: () => {
        opens++;
        throw new Error('permission denied');
      },
      onMessage: () => {},
      // The shape a Session ejection takes: retrying cannot help, so the panel
      // must say fatal rather than sit in backoff looking merely unlucky.
      isFatal: (err) => err instanceof Error && err.message.includes('permission denied'),
      sleep: instantSleep,
      random: () => 0.5,
    });

    c.start();
    await until(() => c.getState().status === 'fatal');
    const opensAtFatal = opens;

    await new Promise((r) => setTimeout(r, 5));
    expect(opens).toBe(opensAtFatal); // no further attempts
    expect(c.getState().lastError).toContain('permission denied');
  });

  it('SeqResume: threads resume headers built from the last message', async () => {
    const headersSeen: (string | null)[] = [];
    let opens = 0;
    const c = new StreamController<{ seq: bigint }>({
      label: 'logs',
      request: undefined,
      open: (_req, { headers }) => {
        headersSeen.push(headers.get('salus-log-since-seq'));
        opens++;
        if (opens === 1) return fromArray([{ seq: 7n }, { seq: 8n }]);
        return fromArray([]); // clean end → reconnect
      },
      onMessage: () => {},
      // The platform's contract, verbatim from the proto field comments: the
      // subscriber sends **the max seq it saw**, and the producer replays
      // `seq > that`. Sending last+1 would ask the producer to skip the very
      // next line — a silent one-line hole on every reconnect.
      resumeHeaders: (last) => (last ? { 'salus-log-since-seq': last.seq.toString() } : undefined),
      sleep: instantSleep,
      random: () => 0.5,
    });

    c.start();
    await until(() => headersSeen.length >= 2);
    await c.stop();

    // First connect asks for nothing; the second resumes AT the last seen seq,
    // exclusive on the producer side, so the replay is gapless and duplicate-free.
    expect(headersSeen[0]).toBeNull();
    expect(headersSeen[1]).toBe('8');
  });

  it('Resnapshot: onConnected runs after open and before any message', async () => {
    const order: string[] = [];
    const c = new StreamController<number>({
      label: 'roster',
      request: undefined,
      open: () => {
        order.push('open');
        return fromArray([1]);
      },
      onConnected: async () => {
        order.push('snapshot');
      },
      onMessage: () => order.push('msg'),
      sleep: instantSleep,
      random: () => 0.5,
    });

    c.start();
    await until(() => order.includes('msg'));
    await c.stop();

    // Subscribe-then-snapshot: any delta the service queued from open-time
    // lands after the snapshot and reconciles on top, so no update is lost.
    expect(order.slice(0, 3)).toEqual(['open', 'snapshot', 'msg']);
  });

  it('treats a failing snapshot as a failed connection and retries', async () => {
    let snapshots = 0;
    const seen: number[] = [];
    const c = new StreamController<number>({
      label: 'roster',
      request: undefined,
      open: () => fromArray([5]),
      onConnected: async () => {
        snapshots++;
        if (snapshots === 1) throw new Error('snapshot unavailable');
      },
      onMessage: (m) => seen.push(m),
      sleep: instantSleep,
      random: () => 0.5,
    });

    c.start();
    await until(() => seen.length === 1);
    await c.stop();
    // A table seeded from a failed snapshot would be wrong for as long as the
    // panel stayed open, so the whole connection is retried instead.
    expect(snapshots).toBe(2);
  });

  it('backoff grows, stays capped, and is jittered', () => {
    const delays: number[] = [];
    const c = new StreamController<number>({
      label: 'backoff',
      request: undefined,
      open: () => fromArray([]),
      onMessage: () => {},
      backoff: { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0.5 },
      random: () => 1, // full positive jitter
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const compute = (attempt: number): number =>
      (c as unknown as { computeDelayMs(a: number): number }).computeDelayMs(attempt);

    expect(compute(1)).toBeCloseTo(150); // 100 + 50% jitter
    expect(compute(2)).toBeCloseTo(300); // 200 + 50%
    expect(compute(10)).toBeLessThanOrEqual(1000); // capped

    // Jitter must actually spread, or a workspace of panels that dropped
    // together retries in lockstep.
    const lo = (
      new StreamController<number>({
        label: 'x',
        request: undefined,
        open: () => fromArray([]),
        onMessage: () => {},
        backoff: { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0.5 },
        random: () => 0,
      }) as unknown as { computeDelayMs(a: number): number }
    ).computeDelayMs(2);
    expect(lo).toBeLessThan(compute(2));
  });

  it('stop() is idempotent and leaves the controller idle', async () => {
    const c = new StreamController<number>({
      label: 'idle',
      request: undefined,
      open: () => fromArray([1]),
      onMessage: () => {},
      sleep: instantSleep,
    });
    c.start();
    await c.stop();
    await c.stop();
    expect(c.getState().status).toBe('idle');
  });

  it('re-resolves a thunk request on every connect', async () => {
    let n = 0;
    const requests: number[] = [];
    const c = new StreamController<number, number>({
      label: 'thunk',
      request: () => ++n,
      open: (req) => {
        requests.push(req);
        return fromArray([]); // clean end → reconnect
      },
      onMessage: () => {},
      sleep: instantSleep,
      random: () => 0.5,
    });

    c.start();
    await until(() => requests.length >= 3);
    await c.stop();
    // A thunk is how a request captures fresh resume state per attempt.
    expect(requests.slice(0, 3)).toEqual([1, 2, 3]);
  });
});
