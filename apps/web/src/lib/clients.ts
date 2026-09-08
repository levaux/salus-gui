/**
 * clients — one Connect client per service, over the shared transport.
 *
 * Panels import from here rather than constructing clients, so there is exactly
 * one place that knows how the console reaches the fleet.
 */
import { createClient } from '@connectrpc/connect';
import { Admin } from '@salus-gui/proto/gen/Admin_pb.js';
import { Network } from '@salus-gui/proto/gen/Network_pb.js';
import { Session } from '@salus-gui/proto/gen/Session_pb.js';
import { ADMIN_TARGET_HEADER } from '@salus-gui/streams';
import { transport } from './transport.js';

export const networkClient = createClient(Network, transport);
export const sessionClient = createClient(Session, transport);

/**
 * Admin is registered on every Component, so a call has to say which one it
 * means. The bridge resolves this address, dials it, and strips the header —
 * upstream it is meaningless, because a service only ever answers for itself.
 */
export const adminClient = createClient(Admin, transport);

export function adminTarget(address: string): { headers: Record<string, string> } {
  return { headers: { [ADMIN_TARGET_HEADER]: address } };
}
