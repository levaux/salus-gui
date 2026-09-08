/**
 * ConnectionManager — bridge liveness plus mass resubscribe.
 *
 * Aggregates reachability into one up/degraded signal that drives the global
 * degraded banner, and on recovery mass-reconnects every registered
 * StreamController — so a bridge restart is a brief blip rather than a session
 * the operator has to reload out of.
 *
 * The probe is a real RPC (`Salus.Admin.Admin/Ping` against Network) rather
 * than a TCP check: the bridge can be listening while the fleet behind it is
 * unreachable, and a health signal that goes green in that state is worse than
 * none. Plain TS with injectable timers so tests drive it deterministically.
 */

export type BridgeHealth = 'up' | 'degraded';

/** Anything the manager can kick to reconnect (StreamController satisfies this). */
export interface Reconnectable {
  readonly label: string;
  reconnect(): void;
}

export interface ConnectionManagerOptions {
  /** Probe the path end to end. Resolves true when reachable. */
  probe: () => Promise<boolean>;
  /** Poll cadence in ms (default 2000). */
  pollIntervalMs?: number;
  /** Notified on every health transition — the degraded banner subscribes. */
  onHealthChange?: (health: BridgeHealth) => void;
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
}

export class ConnectionManager {
  private readonly controllers = new Set<Reconnectable>();
  private readonly opts: ConnectionManagerOptions;
  private readonly pollMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (h: ReturnType<typeof setInterval>) => void;

  private health: BridgeHealth = 'up';
  // Explicit `| undefined` (not `?:`) so `this.timer = undefined` is assignable
  // under exactOptionalPropertyTypes.
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private probing = false;

  constructor(opts: ConnectionManagerOptions) {
    this.opts = opts;
    this.pollMs = opts.pollIntervalMs ?? 2000;
    this.setIntervalFn = opts.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h));
  }

  getHealth(): BridgeHealth {
    return this.health;
  }

  /** Register a controller for mass-resubscribe. Returns an unregister fn. */
  register(controller: Reconnectable): () => void {
    this.controllers.add(controller);
    return () => this.controllers.delete(controller);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalFn(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one health probe now. Re-entrant calls are dropped, not queued. */
  async tick(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const ok = await this.opts.probe();
      this.applyHealth(ok ? 'up' : 'degraded');
    } catch {
      this.applyHealth('degraded');
    } finally {
      this.probing = false;
    }
  }

  /** Direct health signal from a caller that already knows (no probe needed). */
  reportHealth(health: BridgeHealth): void {
    this.applyHealth(health);
  }

  private applyHealth(next: BridgeHealth): void {
    if (next === this.health) return;
    const recovered = this.health === 'degraded' && next === 'up';
    this.health = next;
    this.opts.onHealthChange?.(next);
    if (recovered) this.massReconnect();
  }

  private massReconnect(): void {
    for (const c of this.controllers) c.reconnect();
  }
}
