/**
 * transport — the ONLY place a Connect transport is constructed.
 *
 * `makeTransport(cfg)` points at either the bridge (Connect protocol) or a
 * gRPC-Web proxy; connect-es clients speak both. Centralising construction is
 * what keeps the proxy escape hatch a config change rather than a refactor: if
 * a gRPC-web layer is ever put in front of the Salus fleet, `protocol` flips
 * and nothing else moves.
 */
import { createConnectTransport, createGrpcWebTransport } from '@connectrpc/connect-web';
import { Code, ConnectError, type Transport } from '@connectrpc/connect';

export type TransportProtocol = 'connect' | 'grpc-web';

export interface TransportConfig {
  /** 'connect' → the bridge (/rpc); 'grpc-web' → a proxy in front of the fleet. */
  protocol: TransportProtocol;
  /** Base URL, e.g. https://localhost:56400/rpc. */
  baseUrl: string;
  /** Default unary deadline in ms. Streams are unbounded and ignore it. */
  defaultTimeoutMs?: number;
  /** Send credentials (a session cookie), once the console has auth. */
  withCredentials?: boolean;
}

/**
 * Abort every transport-level fetch the moment the document starts to unload.
 *
 * Root-caused upstream with a CDP stack capture: connect-es's envelope decoder
 * runs `while (!enqueuedOnce) { await reader.read(); … }`. When a reload makes
 * the browser cancel an in-flight streaming response, the cancelled body's
 * reader can resolve `read()` immediately and forever, turning that loop into
 * an infinite microtask spin. Microtasks starve the event loop, so the OLD
 * document's main thread never yields and the new navigation cannot commit —
 * the tab hangs on "loading" and the reload dies with ERR_ABORTED.
 *
 * `beforeunload` fires at navigation START, before the browser cancels
 * anything, so aborting our own fetches there makes every pending `read()`
 * reject with a clean AbortError and the unload proceeds. `pagehide` is the
 * commit-time backstop. Side benefit: the bridge and the services see streams
 * close promptly on reload instead of lingering to a socket timeout, which
 * keeps `Network`'s subscriber counts honest.
 */
let unloadSignal: AbortSignal | undefined;

function documentUnloadSignal(): AbortSignal | undefined {
  if (typeof window === 'undefined') return undefined; // node/vitest: no document lifecycle
  if (!unloadSignal) {
    const ac = new AbortController();
    const abort = (): void => ac.abort(new DOMException('document unloading', 'AbortError'));
    window.addEventListener('beforeunload', abort);
    window.addEventListener('pagehide', abort);
    unloadSignal = ac.signal;
  }
  return unloadSignal;
}

/** A fetch whose calls also abort on document unload (browser only). */
function unloadAwareFetch(): typeof globalThis.fetch | undefined {
  const unload = documentUnloadSignal();
  if (!unload) return undefined;
  return (input, init) => {
    const perCall = init?.signal;
    const signal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any(perCall ? [unload, perCall] : [unload])
        : (perCall ?? unload); // pre-AbortSignal.any fallback: keep the per-call signal
    return globalThis.fetch(input, { ...init, signal });
  };
}

export function makeTransport(cfg: TransportConfig): Transport {
  const fetch = unloadAwareFetch();
  const common = {
    baseUrl: cfg.baseUrl,
    // Binary, so int64 stays bigint. Salus carries identity and watermarks in
    // int64 (`sequence`, `*_us`, Decimal.unscaled); JSON would hand them back
    // as numbers and lose precision above 2^53 without saying so.
    useBinaryFormat: true,
    ...(fetch ? { fetch } : {}),
    ...(cfg.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: cfg.defaultTimeoutMs } : {}),
    ...(cfg.withCredentials ? { credentials: 'include' as const } : {}),
  };
  return cfg.protocol === 'grpc-web'
    ? createGrpcWebTransport(common)
    : createConnectTransport(common);
}

/**
 * Is this error permanent, or worth reconnecting for?
 *
 * UNIMPLEMENTED means the method is not there — retrying cannot help.
 * PERMISSION_DENIED is the shape a **Session ejection** takes: the JWT still
 * verifies cryptographically, but `ext_authz` refuses at the edge. Reconnecting
 * would spin against a decision that has already been made, so it is fatal and
 * the panel must say so rather than sit in backoff looking merely unlucky.
 *
 * Everything else — Unavailable, Canceled, DeadlineExceeded, Internal — is a
 * transient drop worth retrying.
 */
export function isFatalConnectError(err: unknown): boolean {
  if (err instanceof ConnectError) {
    return err.code === Code.Unimplemented || err.code === Code.PermissionDenied;
  }
  return false;
}

/**
 * Metadata key for seq-resumable log streams.
 *
 * `Salus.Admin.LogEntry` and `Salus.Network.AggregatedLogEntry` both carry a
 * monotonic `seq`, and the services replay from a requested one. The bridge
 * forwards request headers verbatim, so resume works with no bridge
 * special-casing — which is exactly why the header, and not a request field,
 * is the mechanism.
 */
export const LOG_SINCE_SEQ_HEADER = 'salus-log-since-seq';

/** Metadata key for the lifecycle-event stream's seq resume. */
export const LIFECYCLE_SINCE_SEQ_HEADER = 'salus-lifecycle-since-seq';

/**
 * Metadata key selecting which Component an `Salus.Admin.Admin` call reaches.
 * Admin is auto-registered on every Component — services and Edge processes
 * alike — so one catalog entry addresses the whole fleet.
 */
export const ADMIN_TARGET_HEADER = 'salus-admin-target';
