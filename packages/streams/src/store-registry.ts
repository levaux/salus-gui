/**
 * StoreRegistry — ref-counted store acquisition with LINGER, the third
 * reconnect contract.
 *
 * A workspace can hold several panels backed by the same feed (a fleet grid and
 * a service detail drawer both want the registry), and navigating between
 * screens acquires and releases the same stores repeatedly. The feed starts on
 * the first acquire; when the LAST holder releases, the stop is **not**
 * immediate — it lingers (45 s by default). Re-acquiring inside that window
 * cancels the pending stop and reuses the still-open streams.
 *
 * The reasoning is asymmetric cost. The streams are multiplexed over one h2
 * connection, so an idle lingering stream costs almost nothing; a re-snapshot
 * costs an authoritative read per table plus the reconcile. Tearing down on
 * every navigation trades something free for something expensive, and the
 * operator sees it as the console flickering every time they change screens.
 *
 * `lingerMs: 0` restores immediate teardown, which is what a test wants and
 * what a deliberate "disconnect everything" control would use.
 *
 * This lives in the streams package rather than the app: it is plain
 * refcounting over injectable timers, the same logic the bridge could use, and
 * putting it here is what makes the contract testable in the single test tier
 * rather than only observable by clicking around.
 */

export const DEFAULT_LINGER_MS = 45_000;

export interface StoreRegistryOptions {
  /** Default linger window in ms for stores that do not override it. */
  lingerMs?: number;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
}

export interface AcquireOptions {
  /** Override the registry default. 0 stops immediately on last release. */
  lingerMs?: number;
}

export class StoreRegistry {
  private readonly counts = new Map<string, number>();
  /** Stores whose start() has run and whose stop() has not. */
  private readonly running = new Set<string>();
  /** Pending delayed stops, cancellable by a re-acquire. */
  private readonly lingers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly defaultLingerMs: number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => void;

  constructor(opts: StoreRegistryOptions = {}) {
    this.defaultLingerMs = opts.lingerMs ?? DEFAULT_LINGER_MS;
    this.setTimeoutFn = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h));
  }

  /** True while the store is started (including during its linger window). */
  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** How many live holders a store has (0 while lingering). */
  holders(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** True when the store has no holders but has not yet been stopped. */
  isLingering(key: string): boolean {
    return this.lingers.has(key);
  }

  /**
   * Acquire a store by key. `start` runs if it is not already live; the
   * returned release schedules `stop` once the last holder lets go and the
   * linger window passes. The release is idempotent — calling it twice does
   * not decrement twice, which matters because component teardown is not
   * always called exactly once.
   */
  acquire(key: string, start: () => void, stop: () => void, opts: AcquireOptions = {}): () => void {
    const lingerMs = opts.lingerMs ?? this.defaultLingerMs;

    // A holder arrived while a delayed stop was pending: the store never
    // stopped, so cancel the stop and keep using it.
    const pending = this.lingers.get(key);
    if (pending !== undefined) {
      this.clearTimeoutFn(pending);
      this.lingers.delete(key);
    }

    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (!this.running.has(key)) {
      this.running.add(key);
      start();
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.counts.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.counts.set(key, remaining);
        return;
      }
      this.counts.delete(key);
      if (lingerMs <= 0) {
        this.running.delete(key);
        stop();
        return;
      }
      this.lingers.set(
        key,
        this.setTimeoutFn(() => {
          this.lingers.delete(key);
          // A racing acquire clears this timer, so reaching here means the
          // store is genuinely unreferenced — stop it for real.
          if (!this.counts.has(key)) {
            this.running.delete(key);
            stop();
          }
        }, lingerMs),
      );
    };
  }

  /** Cancel every pending linger and forget all tracking. Does NOT stop stores. */
  reset(): void {
    for (const t of this.lingers.values()) this.clearTimeoutFn(t);
    this.lingers.clear();
    this.counts.clear();
    this.running.clear();
  }
}

/**
 * The process-wide registry. Stores are module singletons, so their lifecycle
 * tracking is too; tests construct their own `StoreRegistry` instead of
 * reaching for this one.
 */
export const storeRegistry = new StoreRegistry();

/** Convenience bound to the default registry. */
export function acquireStore(
  key: string,
  start: () => void,
  stop: () => void,
  opts: AcquireOptions = {},
): () => void {
  return storeRegistry.acquire(key, start, stop, opts);
}
