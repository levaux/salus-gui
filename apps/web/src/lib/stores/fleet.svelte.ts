/**
 * fleet — the service registry and its per-service metrics.
 *
 * A thin reactive view over the framework-lean pieces in `@salus-gui/streams`:
 * the polling and reconciling happen there, and this file only holds the result
 * in runes so a component can render it.
 *
 * The registry is a **poll**, not a stream, because `Network` exposes no
 * registry delta feed — `GetRegistryStatus` is the authority and there is
 * nothing to subscribe to. Polling something that has no stream is honest;
 * pretending otherwise would mean inventing a delta feed the platform does not
 * have.
 */
import { ConflatedTable } from '@salus-gui/streams';
import { networkClient } from '../clients.js';

export interface ServiceRow {
  name: string;
  adminAddress: string;
  status: number;
  connected: boolean;
  failCount: number;
  authenticatedSubject: string;
  /** From GetAllMetrics — undefined until the first successful read. */
  rpcCount?: bigint;
  rpcActive?: number;
  queueDepth?: number;
  threadPoolSize?: number;
  /** From GetAllStatus. */
  uptimeSeconds?: bigint;
  listenPort?: number;
}

export class FleetStore {
  /** Keyed by service name — the identity the registry itself uses. */
  private readonly table = new ConflatedTable<string, ServiceRow>({
    keyOf: (r) => r.name,
    flushIntervalMs: 16,
  });

  rows = $state<ServiceRow[]>([]);
  error = $state<string | undefined>(undefined);
  lastUpdated = $state<number | undefined>(undefined);
  loading = $state(false);

  private timer: ReturnType<typeof setInterval> | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly pollMs = 3000) {
    this.table.onFlush(() => {
      // Sorted by name so a row never jumps between polls — a table that
      // reorders under the cursor is unusable for comparing two reads.
      this.rows = this.table.values().sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
  }

  /**
   * Read the registry, then the two fan-out surfaces, and reconcile.
   *
   * `applySnapshot` EVICTS services the registry no longer lists — a
   * deregistered service must disappear rather than linger with stale numbers,
   * which is exactly the failure a plain merge would produce.
   */
  async refresh(): Promise<void> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.loading = true;
    try {
      const registry = await networkClient.getRegistryStatus({}, { signal: ac.signal });
      const rows = new Map<string, ServiceRow>(
        registry.entries.map((e) => [
          e.serviceName,
          {
            name: e.serviceName,
            adminAddress: e.adminAddress,
            status: e.status,
            connected: e.connected,
            failCount: e.failCount,
            authenticatedSubject: e.authenticatedSubject,
          },
        ]),
      );

      // Best-effort enrichment: a fleet that answers the registry but not the
      // fan-out should still render, with the extra columns empty rather than
      // the whole panel failing.
      const [status, metrics] = await Promise.allSettled([
        networkClient.getAllStatus({}, { signal: ac.signal }),
        networkClient.getAllMetrics({}, { signal: ac.signal }),
      ]);

      if (status.status === 'fulfilled') {
        for (const e of status.value.entries) {
          const row = rows.get(e.serviceName);
          if (row && e.status) {
            row.uptimeSeconds = e.status.uptimeSeconds;
            row.listenPort = e.status.listenPort;
          }
        }
      }
      if (metrics.status === 'fulfilled') {
        for (const e of metrics.value.entries) {
          const row = rows.get(e.serviceName);
          if (row && e.metrics) {
            row.rpcCount = e.metrics.rpcCount;
            row.rpcActive = e.metrics.rpcActive;
            row.queueDepth = e.metrics.queueDepth;
            row.threadPoolSize = e.metrics.threadPoolSize;
          }
        }
      }

      this.table.applySnapshot(rows.values());
      this.error = undefined;
      this.lastUpdated = Date.now();
    } catch (err) {
      if (ac.signal.aborted) return; // superseded by a newer refresh
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (!ac.signal.aborted) this.loading = false;
    }
  }
}

export const fleet = new FleetStore();
