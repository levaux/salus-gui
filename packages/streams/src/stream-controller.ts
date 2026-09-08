/**
 * StreamController — one server-stream lifecycle with graceful reconnect.
 *
 *   idle → connecting → live → backoff → (live | fatal)
 *
 * Every stream degrades and recovers INDEPENDENTLY, and each panel reports its
 * own stream's health. A console that drops every feed because one service
 * blinked teaches its operator to reload rather than to read.
 *
 * Plain TypeScript — no framework reactivity — so the identical logic runs in
 * the bridge, in vitest under injected clocks, and behind a thin reactive view
 * in the browser. State changes are published through `onStateChange`.
 *
 * ── Two of the three reconnect contracts ride on this class ─────────────────
 *
 *   • SeqResume (logs, lifecycle): `resumeHeaders(lastMsg)` returns the
 *     `salus-*-since-seq` metadata, so the service replays from the exact seq —
 *     no duplicates, no gap, no snapshot needed.
 *
 *   • Resnapshot (rosters, registries, active-session tables): `onConnected`
 *     runs the authoritative read INTO a ConflatedTable after the stream is
 *     open but BEFORE messages are pulled. See ./resnapshot.ts for why that
 *     ordering is the whole point.
 *
 * The third, Linger, is about when a stream is stopped at all, and lives in
 * ./store-registry.ts.
 */

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'backoff' | 'fatal';

export interface StreamControllerState {
  status: StreamStatus;
  /** Consecutive failed-connection count; resets to 0 once a message arrives. */
  attempt: number;
  lastError?: string | undefined;
  msgCount: number;
  /** epoch ms of the most recent message. */
  lastMsgAt?: number;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** Fraction of the delay that is randomised (0 = none, 1 = full jitter). */
  jitter: number;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 250, maxMs: 10_000, factor: 2, jitter: 0.5 };

export interface StreamControllerOptions<TMsg, TReq = void> {
  /** Human label for logs and badges, e.g. "network.StreamLogs". */
  label: string;
  /** The request to (re)issue. A thunk lets it capture fresh resume state. */
  request: TReq | (() => TReq);
  /**
   * Opens the underlying server-stream and returns its message iterable. The
   * controller owns the AbortSignal; `headers` carries resume metadata.
   */
  open: (req: TReq, ctx: { signal: AbortSignal; headers: Headers }) => AsyncIterable<TMsg>;
  /** Delivered once per message, in order. */
  onMessage: (msg: TMsg) => void;
  /**
   * Runs after the stream is established but BEFORE messages are pulled — the
   * re-snapshot point. May be async; if it throws, the connection is treated as
   * failed and retried.
   */
  onConnected?: (ctx: { signal: AbortSignal }) => void | Promise<void>;
  /**
   * Resume headers for the next connect (e.g. `salus-log-since-seq`).
   * `lastMsg` is the most recent message seen, or undefined on first connect.
   */
  resumeHeaders?: (lastMsg: TMsg | undefined) => HeadersInit | undefined;
  /** Stops retrying when true. Defaults to never fatal; pass isFatalConnectError. */
  isFatal?: (err: unknown) => boolean;
  backoff?: Partial<BackoffOptions>;
  onStateChange?: (state: Readonly<StreamControllerState>) => void;
  /** Injectable clock/rng/sleep for deterministic tests. */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError')
  );
}

export class StreamController<TMsg, TReq = void> {
  readonly label: string;
  private readonly opts: StreamControllerOptions<TMsg, TReq>;
  private readonly backoff: BackoffOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  private state: StreamControllerState = { status: 'idle', attempt: 0, msgCount: 0 };
  private abort?: AbortController;
  private running = false;
  private lastMsg: TMsg | undefined;
  private loopPromise?: Promise<void>;

  constructor(opts: StreamControllerOptions<TMsg, TReq>) {
    this.opts = opts;
    this.label = opts.label;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.now = opts.now ?? ((): number => Date.now());
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? realSleep;
  }

  getState(): Readonly<StreamControllerState> {
    return this.state;
  }

  /** Begin (or resume) the lifecycle. Idempotent while already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.runLoop(this.abort.signal);
  }

  /** Stop and cancel the underlying stream. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.setState({ status: 'idle', attempt: 0 });
    try {
      await this.loopPromise;
    } catch {
      /* the loop swallows its own abort */
    }
  }

  /** Force a reconnect now (ConnectionManager's mass-resubscribe). */
  reconnect(): void {
    if (!this.running) {
      this.start();
      return;
    }
    // Cancel the in-flight stream; the loop re-enters connecting immediately.
    this.abort?.abort();
    this.abort = new AbortController();
    this.loopPromise = this.runLoop(this.abort.signal);
  }

  private resolveRequest(): TReq {
    const r = this.opts.request;
    return typeof r === 'function' ? (r as () => TReq)() : r;
  }

  private computeDelayMs(attempt: number): number {
    const raw = this.backoff.baseMs * this.backoff.factor ** (attempt - 1);
    const capped = Math.min(this.backoff.maxMs, raw);
    const jitterSpan = capped * this.backoff.jitter;
    // Symmetric jitter around the capped delay, clamped to [baseMs/2, maxMs].
    // Jitter is not decoration: without it, every panel in a workspace that
    // dropped together retries in lockstep and hammers the service it is
    // waiting on.
    const delta = (this.random() * 2 - 1) * jitterSpan;
    return Math.max(this.backoff.baseMs / 2, Math.min(this.backoff.maxMs, capped + delta));
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        this.setState({ status: 'connecting' });
        const headers = new Headers(this.opts.resumeHeaders?.(this.lastMsg) ?? undefined);
        const iterable = this.opts.open(this.resolveRequest(), { signal, headers });

        // Re-snapshot point: the stream is open, so deltas queue service-side
        // while this runs.
        if (this.opts.onConnected) await this.opts.onConnected({ signal });
        if (!this.running || signal.aborted) return;

        this.setState({ status: 'live' });

        for await (const msg of iterable) {
          if (signal.aborted) break;
          this.lastMsg = msg;
          this.opts.onMessage(msg);
          this.setState({
            status: 'live',
            attempt: 0, // a delivered message proves liveness → reset backoff
            msgCount: this.state.msgCount + 1,
            lastMsgAt: this.now(),
            lastError: undefined, // recovered — clear the stale error the badge showed
          });
        }

        // Clean end-of-stream: a reconnectable drop unless we were stopped.
        if (!this.running || signal.aborted) return;
        await this.backoffAndWait(signal, undefined);
      } catch (err) {
        if (isAbort(err) || signal.aborted || !this.running) return;
        if (this.opts.isFatal?.(err)) {
          this.setState({ status: 'fatal', lastError: errMessage(err) });
          this.running = false;
          return;
        }
        await this.backoffAndWait(signal, err);
      }
    }
  }

  private async backoffAndWait(signal: AbortSignal, err: unknown): Promise<void> {
    const attempt = this.state.attempt + 1;
    this.setState({
      status: 'backoff',
      attempt,
      ...(err !== undefined ? { lastError: errMessage(err) } : {}),
    });
    try {
      await this.sleep(this.computeDelayMs(attempt), signal);
    } catch {
      /* aborted during backoff */
    }
  }

  private setState(patch: Partial<StreamControllerState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onStateChange?.(this.state);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
