/**
 * @salus-gui/streams — the console's data layer.
 *
 * Framework-lean by design: no reactivity primitives anywhere in this package,
 * so the same code runs in the browser behind a thin reactive view, in the
 * bridge, and in vitest under injected clocks. Three reconnect contracts live
 * here and are pinned by tests:
 *
 *   SeqResume   — logs and lifecycle resume by `seq` (StreamController +
 *                 the `salus-*-since-seq` headers).
 *   Resnapshot  — tables re-read their authority on reconnect, in
 *                 subscribe-then-snapshot order (bindResnapshot).
 *   Linger      — a released feed stays alive briefly, so navigation reuses
 *                 streams instead of re-snapshotting (StoreRegistry).
 */
export * from './transport.js';
export * from './stream-controller.js';
export * from './conflated-table.js';
export * from './resnapshot.js';
export * from './ring-buffer.js';
export * from './series-buffer.js';
export * from './connection-manager.js';
export * from './store-registry.js';
