/**
 * bindResnapshot — the re-snapshot reconnect contract, made explicit.
 *
 * Tables whose feed carries no resumable sequence (the service registry, the
 * session roster, the active-therapy registry) MUST re-read their authoritative
 * state on every (re)connect. Re-opening the delta stream alone is not enough:
 * whatever changed while the tab was disconnected is simply gone, and the table
 * would keep showing rows that no longer exist.
 *
 * The ordering is **subscribe-then-snapshot**, which is why this composes with
 * StreamController's `onConnected` hook (which fires after the stream is open,
 * before messages are pulled):
 *
 *   1. open the delta stream            → the service queues deltas from here
 *   2. fetch the snapshot (onConnected) → authoritative state up to "now"
 *   3. applySnapshot(rows)              → seed the table, evict stale keys
 *   4. drain queued + live deltas       → applied on top, idempotent by key
 *
 * No delta can be lost between (1) and (2), because the stream is already open
 * when the snapshot is taken. A snapshot-then-subscribe ordering leaves exactly
 * that gap, and the resulting row is wrong for as long as the panel stays open
 * — the failure this contract exists to make structurally impossible.
 */
import { StreamController, type StreamControllerOptions } from './stream-controller.js';
import type { ConflatedTable } from './conflated-table.js';

export interface ResnapshotOptions<TMsg, K, Row, TReq = void> {
  label: string;
  table: ConflatedTable<K, Row>;
  /** Fetch the authoritative full row set (e.g. GetRegistryStatus, ListSessions). */
  snapshot: (signal: AbortSignal) => Promise<Iterable<Row>>;
  /** Open the delta stream (e.g. StreamLifecycleEvents, SubscribeActiveTherapies). */
  open: StreamControllerOptions<TMsg, TReq>['open'];
  request: StreamControllerOptions<TMsg, TReq>['request'];
  /** Apply one delta message to the table (upsert/remove). */
  apply: (msg: TMsg, table: ConflatedTable<K, Row>) => void;
  isFatal?: StreamControllerOptions<TMsg, TReq>['isFatal'];
  backoff?: StreamControllerOptions<TMsg, TReq>['backoff'];
  onStateChange?: StreamControllerOptions<TMsg, TReq>['onStateChange'];
  now?: StreamControllerOptions<TMsg, TReq>['now'];
  random?: StreamControllerOptions<TMsg, TReq>['random'];
  sleep?: StreamControllerOptions<TMsg, TReq>['sleep'];
}

/**
 * Wire a re-snapshotting table feed. Returns the StreamController — call
 * `.start()` to run it; every reconnect re-snapshots automatically.
 */
export function bindResnapshot<TMsg, K, Row, TReq = void>(
  opts: ResnapshotOptions<TMsg, K, Row, TReq>,
): StreamController<TMsg, TReq> {
  return new StreamController<TMsg, TReq>({
    label: opts.label,
    request: opts.request,
    open: opts.open,
    onConnected: async ({ signal }) => {
      const rows = await opts.snapshot(signal);
      if (signal.aborted) return;
      opts.table.applySnapshot(rows); // reconcile: seed + evict stale
    },
    onMessage: (msg) => opts.apply(msg, opts.table),
    // These feeds do not seq-resume; the snapshot IS the resume mechanism.
    ...(opts.isFatal ? { isFatal: opts.isFatal } : {}),
    ...(opts.backoff ? { backoff: opts.backoff } : {}),
    ...(opts.onStateChange ? { onStateChange: opts.onStateChange } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
}
