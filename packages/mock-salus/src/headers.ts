/**
 * headers — the metadata keys the mock honours.
 *
 * Duplicated from `@salus-gui/streams` rather than imported: the mock is a
 * *server*, and depending on the client data layer to know its own wire
 * contract would make the two impossible to test independently. The values are
 * the platform's own, documented in the vendored protos' field comments
 * (`Salus.Admin.LogEntry.seq`, `Salus.Network.LifecycleEvent.seq`), which is
 * the actual authority for both sides.
 *
 * A drift test in the streams package would be the belt-and-braces version;
 * for now the shared authority is the proto comment, and both constants are
 * asserted against literal strings in tests so a silent rename fails loudly.
 */
export const LOG_SINCE_SEQ_HEADER = 'salus-log-since-seq';
export const LIFECYCLE_SINCE_SEQ_HEADER = 'salus-lifecycle-since-seq';
export const ADMIN_TARGET_HEADER = 'salus-admin-target';
