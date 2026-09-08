/**
 * scripted-stream — deterministic frame replay under an injectable clock.
 *
 * Turns a list of `{ atMs, seq?, data }` frames into an async iterable that
 * replays in `atMs` order, waiting `(next - previous) / speed` between them.
 * The wait goes through a `VirtualClock`, so a test can swap in a clock that
 * resolves instantly while *recording the requested durations* — the ordering
 * and pacing are then unit-tested with no wall-clock waiting at all.
 *
 * `startingSeq` is the seq-resume primitive the log and lifecycle streams build
 * on: frames are filtered to `seq > startingSeq` before replay, which is
 * exactly the platform's documented `salus-log-since-seq` contract.
 */

/** One frame: `data` fires `atMs` virtual-ms after the stream starts. */
export interface ScriptedFrame<T> {
  readonly atMs: number;
  /** Monotonic sequence — present only on seq-resumable streams. */
  readonly seq?: bigint;
  readonly data: T;
}

/** Injectable pacing clock. Real playback uses `realClock`; tests use their own. */
export interface VirtualClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Real-time clock — actual `setTimeout`, abortable via `signal`. */
export const realClock: VirtualClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason as Error);
        },
        { once: true },
      );
    }),
};

export interface ScriptedStreamOptions<T> {
  readonly frames: readonly ScriptedFrame<T>[];
  /** Speed multiplier — 2 halves each wait, 0.5 doubles it. Default 1. */
  readonly speed?: number;
  /** Resume point: only frames with `seq > startingSeq` are emitted. */
  readonly startingSeq?: bigint;
  readonly clock?: VirtualClock;
}

export class ScriptedStream<T> implements AsyncIterable<T> {
  private readonly frames: readonly ScriptedFrame<T>[];
  private readonly speed: number;
  private readonly clock: VirtualClock;

  constructor(opts: ScriptedStreamOptions<T>) {
    this.speed = opts.speed ?? 1;
    this.clock = opts.clock ?? realClock;

    const startingSeq = opts.startingSeq;
    const filtered =
      startingSeq === undefined
        ? opts.frames
        : opts.frames.filter((f) => f.seq !== undefined && f.seq > startingSeq);

    // Always replay by `atMs`, never by list order — the ordering must be a
    // property of the data, not of how the fixture happened to be written.
    this.frames = [...filtered].sort((a, b) => a.atMs - b.atMs);
  }

  get length(): number {
    return this.frames.length;
  }

  async *play(signal?: AbortSignal): AsyncGenerator<T, void, undefined> {
    let previousAtMs = 0;
    for (const frame of this.frames) {
      const waitMs = Math.max(0, (frame.atMs - previousAtMs) / this.speed);
      // Always await, even for 0 ms, so pacing is uniform per frame and a test
      // clock records every boundary.
      await this.clock.sleep(waitMs, signal);
      previousAtMs = frame.atMs;
      yield frame.data;
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    return this.play();
  }
}
