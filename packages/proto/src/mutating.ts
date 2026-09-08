/**
 * mutating — the hand-curated set of RPCs that change fleet state.
 *
 * Two consumers, both in the bridge: the fleet-wide **read-only switch**
 * (a listed RPC is refused with FAILED_PRECONDITION at one flip) and the
 * **audit log** (a listed RPC is recorded with its caller and target).
 *
 * Hand-curated, deliberately. There is no reliable way to derive "does this
 * change something" from a descriptor — `Reset` and `Drain` read like queries
 * and are among the most destructive calls here, while `QueryTherapyMetrics`
 * writes nothing despite its cost. A curated list is auditable by reading it;
 * a clever heuristic is not.
 *
 * **The safe failure direction is over-listing.** A mutator missing from this
 * set is a call that read-only mode silently permits — the failure that makes
 * the switch a lie. An over-listed read is merely a call refused in read-only
 * mode, which an operator notices immediately and reports. When unsure, list it.
 *
 * Keys are the Connect procedure path without a leading slash:
 * `<proto package>.<Service>/<Method>`.
 */
export const MUTATING_RPCS: ReadonlySet<string> = new Set([
  // --- Admin: present on EVERY Component, so each of these can be aimed at
  // any process in the fleet via the `salus-admin-target` header.
  'Salus.Admin.Admin/Drain', // stops accepting new work
  'Salus.Admin.Admin/Shutdown', // stops the process
  'Salus.Admin.Admin/SetTrace', // changes live logging
  'Salus.Admin.Admin/SetDebug',

  // --- Network: the fleet fan-out. These reach every registered service at
  // once, which makes them the highest-blast-radius calls the console can make.
  'Salus.Network.Network/DrainAll',
  'Salus.Network.Network/ShutdownAll',
  'Salus.Network.Network/Reset', // clears collected telemetry
  'Salus.Network.Network/Register', // registry membership
  'Salus.Network.Network/Deregister',

  // --- Session: the live-control plane. EjectSession is the primitive that
  // cuts a client off in real time — the next edge call fails at ext_authz.
  'Salus.Session.Session/EjectSession',
  'Salus.Session.Session/OpenSession',
  'Salus.Session.Session/BindEdgeInstallation',
  'Salus.Session.Session/ReportPresence',

  // --- Protocol: the operator pipeline. Publish is irreversible (revisions are
  // immutable) and Allocate changes what a real device will execute next.
  'Salus.Protocol.Protocol/ImportProtocolArtifact',
  'Salus.Protocol.Protocol/PublishProtocolRevision',
  'Salus.Protocol.Protocol/AllocateProtocol',
  'Salus.Protocol.Protocol/AcknowledgeAssignment',
  'Salus.Protocol.Protocol/ReportProtocolProgress',

  // --- Therapy: the reconciliation verdict is a durable, safety-relevant
  // decision about a therapy session.
  'Salus.Therapy.Therapy/ApplyReconciliationDecision',

  // --- Edge application: drives the device-facing routine schedule on a live
  // Edge process.
  'Salus.EdgeApplication.EdgeApplication/StartRoutine',
  'Salus.EdgeApplication.EdgeApplication/SkipRoutine',
]);

/**
 * `ValidateProtocolCandidate` is deliberately absent: it is a pure check that
 * persists nothing. `Authenticate` is absent too — it mints a token and opens a
 * session, which IS a state change, but refusing it in read-only mode would
 * lock the operator out of the very surface they use to observe. It is audited
 * instead, by the bridge's own rule for credential-bearing calls.
 */
export function isMutating(procedure: string): boolean {
  return MUTATING_RPCS.has(procedure.replace(/^\//, ''));
}
