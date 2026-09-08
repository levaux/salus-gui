/**
 * transport — the console's single connection to the bridge.
 *
 * One transport for the whole app, built once. Every client shares it, which is
 * what makes the streams multiplex over one h2 connection rather than opening
 * one apiece.
 *
 * Two origins, and the difference matters:
 *   • Same-origin `/rpc` (default): the browser talks to whatever served the
 *     page — in dev that is Vite, which proxies to the bridge over HTTP/1.1.
 *     Fine for a handful of feeds.
 *   • `VITE_RPC_ORIGIN`: the browser talks to the bridge directly, so the
 *     streams share ONE h2 connection. Necessary once a workspace holds more
 *     than a few live feeds, because Vite's HTTP/1.1 proxy hits the browser's
 *     ~6-connections-per-origin ceiling and later streams silently never open.
 */
import { makeTransport } from '@salus-gui/streams';
import type { Transport } from '@connectrpc/connect';

const origin = import.meta.env.VITE_RPC_ORIGIN ?? '';

export const RPC_BASE_URL = `${origin}/rpc`;

/** Where bridge-local endpoints live (`/bridge/*`, `/kv/*`). */
export const BRIDGE_BASE_URL = origin;

export const transport: Transport = makeTransport({
  protocol: 'connect',
  baseUrl: RPC_BASE_URL,
  // Unary calls get a deadline; streams are unbounded and ignore it. Five
  // seconds is long enough for a loaded fleet and short enough that a wedged
  // call surfaces as an error rather than a spinner nobody can explain.
  defaultTimeoutMs: 5_000,
});

export interface BridgeInfo {
  site: string;
  name: string;
  env: 'dev' | 'mock' | 'staging' | 'prod';
  host: string;
  portBase: number | null;
  readOnly: boolean;
}

/** Which fleet the bridge is pointed at — drives the environment band. */
export async function fetchBridgeInfo(signal?: AbortSignal): Promise<BridgeInfo> {
  const res = await fetch(`${BRIDGE_BASE_URL}/bridge/info`, signal ? { signal } : {});
  if (!res.ok) throw new Error(`bridge/info: HTTP ${res.status}`);
  return (await res.json()) as BridgeInfo;
}

/** Flip the fleet-wide read-only switch. */
export async function setReadOnly(readOnly: boolean): Promise<boolean> {
  const res = await fetch(`${BRIDGE_BASE_URL}/bridge/readonly`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ readOnly }),
  });
  if (!res.ok) throw new Error(`bridge/readonly: HTTP ${res.status}`);
  return ((await res.json()) as { readOnly: boolean }).readOnly;
}
