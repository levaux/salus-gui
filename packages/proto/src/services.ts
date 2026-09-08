/**
 * services — the console's service catalog.
 *
 * One entry per service the console speaks to. This is the single place a
 * service is declared: the bridge's generic forward walks these descriptors to
 * build a route per method, the browser builds one Connect client per entry,
 * and mock-salus registers handlers against the same list. Adding a service to
 * the console is one line here.
 *
 * PORTS are the Salus production ports (docs/service-ports.md in the platform
 * repo): 57xxx is a service, 58xxx a test process. The console's own ports sit
 * outside both bands (bridge 56400, mock hub 56800) so a mock and a real fleet
 * can run side by side.
 *
 * The mock rebases the whole catalog onto its single hub with
 * `port = portBase + (catalogPort - 57000)`, so `portBase: 56800` maps Network
 * to 56800, Authentication to 56810, and so on — one process answering
 * everything, with the offsets preserved.
 */
import { Admin } from './gen/Admin_pb.js';
import { Authentication } from './gen/Authentication_pb.js';
import { EdgeApplication } from './gen/EdgeApplication_pb.js';
import { Health } from './gen/Health_pb.js';
import { Network } from './gen/Network_pb.js';
import { Protocol } from './gen/Protocol_pb.js';
import { Session } from './gen/Session_pb.js';
import { Therapy } from './gen/Therapy_pb.js';

/** The base every catalog port is expressed relative to (Network, the platform hub). */
export const CATALOG_PORT_BASE = 57000;

export interface ServiceEntry {
  /** Stable id used in bridge routes, config and the audit log. */
  readonly id: string;
  /** Human label for the console's own surfaces. */
  readonly label: string;
  /** The generated service descriptor. */
  readonly service: unknown;
  /** Salus production port. */
  readonly port: number;
  /**
   * True when the target is not a fixed fleet port but supplied per call —
   * Admin exists on every Component (via the `salus-admin-target` header) and
   * EdgeApplication lives on whatever `--port` an Edge process was given.
   */
  readonly dynamicTarget?: boolean;
  /** One line on why the console talks to it. */
  readonly note: string;
}

export const SERVICE_CATALOG: readonly ServiceEntry[] = [
  {
    id: 'network',
    label: 'Network',
    service: Network,
    port: 57000,
    note: 'Registry, fleet fan-out (GetAllStatus/GetAllMetrics), aggregated logs, lifecycle and suite-snapshot streams.',
  },
  {
    id: 'admin',
    label: 'Admin',
    service: Admin,
    port: 57000,
    dynamicTarget: true,
    note: 'Auto-registered on every Component, Edge processes included. The `salus-admin-target` header picks which one.',
  },
  {
    id: 'authentication',
    label: 'Authentication',
    service: Authentication,
    port: 57010,
    note: 'Authenticate/Validate. Used by the token workbench to mint a device-plane JWT deliberately.',
  },
  {
    id: 'session',
    label: 'Session',
    service: Session,
    port: 57020,
    note: 'Session roster, edge bindings, device presence — and EjectSession, the live-control primitive.',
  },
  {
    id: 'health',
    label: 'Health',
    service: Health,
    port: 57030,
    note: 'Query + subscribe surfaces only. StreamHealth is the Edge ingest bidi and is never browser-forwarded.',
  },
  {
    id: 'therapy',
    label: 'Therapy',
    service: Therapy,
    port: 57040,
    note: 'Active-therapy registry, query + subscribe. StreamTherapy is the Edge ingest bidi and is never browser-forwarded.',
  },
  {
    id: 'protocol',
    label: 'Protocol',
    service: Protocol,
    port: 57050,
    note: 'Operator pipeline (import/validate/publish/allocate) plus the pull surface and WatchAssignment.',
  },
  {
    id: 'edgeapplication',
    label: 'Edge Application',
    service: EdgeApplication,
    port: 58070,
    dynamicTarget: true,
    note: "The Edge's loopback control surface, served on its own --port when run with --application-control. 58070 is the harness convention, not a fixed port.",
  },
] as const;

export function serviceById(id: string): ServiceEntry | undefined {
  return SERVICE_CATALOG.find((s) => s.id === id);
}

/**
 * A method, in the two names it actually has.
 *
 * protobuf-es keys a service's methods by their **camelCase local name**
 * (`drain`, `streamLogs`) while the Connect/gRPC wire path uses the
 * **proto name** (`Drain`, `StreamLogs`). Routing on the descriptor key
 * produces paths the backend answers with UNIMPLEMENTED, and nothing about
 * the type system catches it — so the conversion lives here, once, and both
 * the bridge's router and the mutating-RPC gate read it from this helper.
 */
export interface CatalogMethod {
  /** Descriptor key — how you reach the method on the generated object. */
  readonly localName: string;
  /** Proto name — what goes on the wire. */
  readonly name: string;
  /** 'unary' | 'server_streaming' | 'client_streaming' | 'bidi_streaming'. */
  readonly kind: string;
  /** Full Connect procedure path, no leading slash: `<package>.<Service>/<Method>`. */
  readonly procedure: string;
}

interface RuntimeService {
  typeName: string;
  method: Record<string, { name: string; methodKind: string }>;
}

export function methodsOf(entry: ServiceEntry): CatalogMethod[] {
  const svc = entry.service as RuntimeService;
  return Object.entries(svc.method).map(([localName, m]) => ({
    localName,
    name: m.name,
    kind: m.methodKind,
    procedure: `${svc.typeName}/${m.name}`,
  }));
}

/** Every procedure the catalog can address, as wire paths. */
export function allProcedures(): string[] {
  return SERVICE_CATALOG.flatMap((entry) => methodsOf(entry).map((m) => m.procedure));
}

/**
 * The streaming kinds the browser may consume. Client- and bidi-streaming RPCs
 * (`StreamHealth`, `StreamTherapy`) are the Edge's acknowledged ingest sessions
 * and are never forwarded to a browser — the console observes their effects
 * through the query and subscribe surfaces instead (plan 001 decision 4).
 */
export const FORWARDABLE_KINDS: ReadonlySet<string> = new Set(['unary', 'server_streaming']);

export function isForwardable(m: CatalogMethod): boolean {
  return FORWARDABLE_KINDS.has(m.kind);
}

/** Rebase a catalog port onto a hub base — how the mock answers the whole fleet on one port. */
export function rebasePort(catalogPort: number, portBase: number): number {
  return portBase + (catalogPort - CATALOG_PORT_BASE);
}
