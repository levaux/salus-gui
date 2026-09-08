/**
 * forward — the generic Connect → gRPC forwarding router.
 *
 * One function drives the whole RPC surface: given a catalog entry and its
 * backend transport, it walks the service descriptor's methods and wires each
 * onto the bridge's router.
 *
 *   unary            → await transport.unary(), return the message
 *   server_streaming → async-generator piping transport.stream()'s output
 *   client/bidi      → SKIPPED, by rule
 *
 * The skip is a decision, not a gap. The only client- and bidi-streaming RPCs
 * in the Salus catalog are the Edge's acknowledged ingest sessions
 * (`StreamHealth`, `StreamTherapy`) and `Network.PushNetworkStats`. Forwarding
 * one would mean the bridge originates an ingest session *to* the platform on a
 * browser's behalf — claiming to be an Edge — which a generic proxy has no
 * business doing. The console observes their effects through the query and
 * subscribe surfaces instead.
 *
 * **Request headers cross verbatim.** That is what makes `salus-log-since-seq`
 * resume work with zero special-casing here, and what will make an
 * `Authorization` bearer pass through unchanged when the token workbench lands.
 * The two exclusion lists below are the minimum: connection-specific headers
 * HTTP/2 forbids, and framing/codec headers the upstream transport sets for
 * itself.
 */
import { Code, ConnectError } from '@connectrpc/connect';
import type { ConnectRouter, HandlerContext, Transport } from '@connectrpc/connect';
import type { GenService } from '@bufbuild/protobuf/codegenv2';
import { isMutating } from '@salus-gui/proto';

import { hashInput, type AuditLog } from './audit.js';
import { ADMIN_TARGET_HEADER } from './headers.js';
import type { SiteContext } from './services.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGenService = GenService<any>;
type ServiceMethod = AnyGenService['method'][string];

export interface ForwardableEntry {
  readonly id: string;
  readonly service: AnyGenService;
}

export type TransportPicker = (header: Headers) => Transport;

export interface ForwardOptions {
  readonly site: SiteContext;
  readonly audit: AuditLog;
  /** Per-call transport override — the Admin surface's target routing. */
  readonly dynamicTransport?: (header: Headers) => Transport | undefined;
}

/** Wire every forwardable method of `entry.service` onto `router`. */
export function forwardService(
  router: ConnectRouter,
  entry: ForwardableEntry,
  transport: Transport,
  opts: ForwardOptions,
): void {
  const { service } = entry;
  const pick: TransportPicker = (header) => opts.dynamicTransport?.(header) ?? transport;

  for (const method of Object.values(service.method)) {
    const procedure = `${service.typeName}/${method.name}`;
    switch (method.methodKind) {
      case 'unary':
        // connect v2: router.rpc(method, impl) — the descriptor carries its
        // parent service. The cast is because generic forwarding iterates a
        // union over all method kinds, which the typed overloads cannot accept.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (router.rpc as any)(method, makeUnaryHandler(pick, service, method, opts));
        break;
      case 'server_streaming':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (router.rpc as any)(method, makeStreamHandler(pick, service, method, opts));
        break;
      case 'client_streaming':
      case 'bidi_streaming':
        break; // by rule — see the module comment
      default:
        console.debug(`forward: skipping ${procedure} (unknown kind)`);
    }
  }
}

/** Throws FAILED_PRECONDITION iff the procedure mutates and the site is read-only. */
function guardReadOnly(procedure: string, site: SiteContext): void {
  if (isMutating(procedure) && site.readOnly) {
    throw new ConnectError(
      `${procedure}: site '${site.site.id}' is in read-only mode`,
      Code.FailedPrecondition,
    );
  }
}

/**
 * Upstream response headers that must NOT reach the browser. The upstream
 * speaks gRPC, so its response says `content-type: application/grpc+proto`;
 * copying that clobbers the Connect content-type the adapter set, and the
 * browser client then rejects the response as an unsupported content type.
 * The adapter owns framing; only custom metadata should cross back.
 */
const NON_FORWARDABLE_RESPONSE_HEADERS = new Set<string>([
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'trailer',
  'te',
  'upgrade',
  'grpc-encoding',
  'grpc-accept-encoding',
  'grpc-status',
  'grpc-message',
  'grpc-status-details-bin',
]);

export function copyResponseHeaders(from: Headers, to: Headers): void {
  from.forEach((value, key) => {
    if (!NON_FORWARDABLE_RESPONSE_HEADERS.has(key.toLowerCase())) to.set(key, value);
  });
}

/**
 * The error-path twin. A failed upstream call yields a ConnectError whose
 * metadata carries the upstream's gRPC response headers verbatim — including
 * the gRPC content-type — and the adapter merges error metadata into the
 * browser response. Left alone that clobbers the Connect content-type and the
 * browser sees a bare HTTP status instead of the backend's actual reason.
 */
export function scrubErrorMetadata(err: unknown): ConnectError {
  const ce = err instanceof ConnectError ? err : ConnectError.from(err);
  for (const key of NON_FORWARDABLE_RESPONSE_HEADERS) ce.metadata.delete(key);
  return ce;
}

/**
 * Client-side stream teardown. The browser resets its h2 streams with CANCEL or
 * INTERNAL_ERROR on reload, tab close, HMR and sleep-wake, and a client that
 * vanished before trailers surfaces as "missing status". All routine.
 */
const CLIENT_RESET =
  /stream closed with error code (CANCEL|INTERNAL_ERROR)|protocol error: missing status/;

export function isClientDisconnect(err: unknown): boolean {
  if (!(err instanceof ConnectError)) return false;
  if (err.code === Code.Canceled) return true;
  return (
    (err.code === Code.Internal || err.code === Code.Aborted) && CLIENT_RESET.test(err.rawMessage)
  );
}

/**
 * Headers that must NOT go upstream. The browser may reach the bridge over
 * HTTP/1.1 (via a dev proxy), so its request carries connection-specific
 * headers Node's HTTP/2 client rejects outright, plus framing and protocol
 * headers the upstream transport sets for itself — forwarding those corrupts
 * the re-encoded call. Everything else passes through, which is the point.
 */
const NON_FORWARDABLE_REQUEST_HEADERS = new Set<string>([
  // HTTP/2 forbids these connection-specific headers (RFC 9113 §8.2.2):
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  // routing — the upstream URL defines :authority/host:
  'host',
  // framing / codec — the transport sets these:
  'content-type',
  'content-length',
  'content-encoding',
  'accept-encoding',
  // protocol negotiation — managed by the transport, not proxied:
  'te',
  'trailer',
  'connect-protocol-version',
  'connect-timeout-ms',
  // bridge-internal routing directive — consumed here, never sent upstream:
  ADMIN_TARGET_HEADER,
]);

export function forwardableRequestHeaders(from: Headers): Headers {
  const out = new Headers();
  from.forEach((value, key) => {
    if (!NON_FORWARDABLE_REQUEST_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

function makeUnaryHandler(
  pick: TransportPicker,
  service: AnyGenService,
  method: ServiceMethod,
  opts: ForwardOptions,
) {
  const procedure = `${service.typeName}/${method.name}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (input: any, context: HandlerContext): Promise<any> => {
    guardReadOnly(procedure, opts.site);
    const transport = pick(context.requestHeader);
    const startedAt = Date.now();
    let outcome: 'ok' | 'error' = 'ok';
    try {
      // connect v2: Transport.unary(method, signal, timeoutMs, header, input).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (transport.unary as any)(
        method,
        context.signal,
        undefined, // the incoming deadline rides the signal
        forwardableRequestHeaders(context.requestHeader),
        input,
      );
      copyResponseHeaders(response.header, context.responseHeader);
      return response.message;
    } catch (err) {
      outcome = 'error';
      throw scrubErrorMetadata(err);
    } finally {
      void opts.audit.append({
        ts: startedAt,
        site: opts.site.site.id,
        service: service.typeName,
        rpc: method.name,
        argsHash: hashInput(input),
        outcome,
        latencyMs: Date.now() - startedAt,
        mutating: isMutating(procedure),
      });
    }
  };
}

function makeStreamHandler(
  pick: TransportPicker,
  service: AnyGenService,
  method: ServiceMethod,
  opts: ForwardOptions,
) {
  const procedure = `${service.typeName}/${method.name}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function* (input: any, context: HandlerContext): AsyncIterable<any> {
    guardReadOnly(procedure, opts.site);
    const transport = pick(context.requestHeader);
    const startedAt = Date.now();
    let outcome: 'ok' | 'error' = 'ok';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (transport.stream as any)(
        method,
        context.signal,
        undefined, // streams are unbounded — no deadline
        forwardableRequestHeaders(context.requestHeader),
        singleton(input),
      );
      copyResponseHeaders(response.header, context.responseHeader);
      for await (const message of response.message) yield message;
    } catch (err) {
      outcome = 'error';
      // Routine teardown gets one quiet line, no stack. A page reload resets
      // every open stream at once, so logging each as an error turns one
      // reload into a hundred lines and buries the real faults.
      if (isClientDisconnect(err)) {
        console.log(`forward: stream ${procedure} ended by client disconnect`);
      } else {
        console.error(`forward: stream ${procedure} failed:`, err);
      }
      throw scrubErrorMetadata(err);
    } finally {
      void opts.audit.append({
        ts: startedAt,
        site: opts.site.site.id,
        service: service.typeName,
        rpc: method.name,
        argsHash: hashInput(input),
        outcome,
        latencyMs: Date.now() - startedAt,
        mutating: isMutating(procedure),
      });
    }
  };
}

/** Wraps one request message as the one-shot AsyncIterable `stream` expects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* singleton(value: any): AsyncIterable<any> {
  yield value;
}
