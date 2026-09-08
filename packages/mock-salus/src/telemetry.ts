/**
 * telemetry — the mock's `Salus.Network.SuiteSnapshot` world.
 *
 * Network aggregates a per-(component, direction, method) table out of the
 * digests every Component pushes it, and serves the whole thing as one
 * snapshot. This module reproduces that table deterministically.
 *
 * **Method names come from the real descriptors, not from a list written here.**
 * `methodsOf(SERVICE_CATALOG)` is the same source the bridge and the catalog
 * drift test use, so the telemetry the console renders offline carries the
 * method names a live fleet would report, and a proto rename shows up here
 * instead of silently disagreeing.
 *
 * One deliberate asymmetry: a **full snapshot has no sequence number**.
 * `SuiteSnapshot` carries `snapshot_at_us`, `components[]` and `rows[]` and
 * nothing else, and `StreamSuiteSnapshotRequest` is empty — so this feed is
 * Resnapshot, not SeqResume, and there is no resume header to honour. See the
 * design reference §7.8: anything that would render a snapshot `seq` has to
 * render age instead, because the number does not exist.
 */
import { SERVICE_CATALOG, methodsOf } from '@salus-gui/proto';
import { intBetween, unit, wave } from './deterministic.js';

/** `Salus.Network.RpcKind` numeric values. */
export const RpcKindValue = {
  UNSPECIFIED: 0,
  UNARY: 1,
  STREAMING_SEND: 2,
  STREAMING_RECV: 3,
  STREAMING_BIDI: 4,
} as const;

/** `Salus.Network.Direction` numeric values. */
export const DirectionValue = {
  UNSPECIFIED: 0,
  INBOUND: 1,
  OUTBOUND: 2,
} as const;

/** gRPC status codes we deliberately populate. 0 OK, 7 PERMISSION_DENIED, 14 UNAVAILABLE. */
const STATUS_OK = 0;
const STATUS_PERMISSION_DENIED = 7;
const STATUS_UNAVAILABLE = 14;
const STATUS_CODE_SLOTS = 17;

/** protobuf-es `methodKind` → the proto's closed `RpcKind` catalog. */
function rpcKindOf(kind: string): number {
  switch (kind) {
    case 'unary':
      return RpcKindValue.UNARY;
    case 'server_streaming':
      return RpcKindValue.STREAMING_SEND;
    case 'client_streaming':
      return RpcKindValue.STREAMING_RECV;
    case 'bidi_streaming':
      return RpcKindValue.STREAMING_BIDI;
    default:
      return RpcKindValue.UNSPECIFIED;
  }
}

export interface MockTelemetryRow {
  readonly component: string;
  readonly name: string;
  readonly kind: number;
  readonly direction: number;
  readonly callsTotal: bigint;
  readonly bytesInTotal: bigint;
  readonly bytesOutTotal: bigint;
  readonly bpsIn1s: number;
  readonly bpsOut1s: number;
  readonly msgRate1s: number;
  readonly latencyP50Us: number;
  readonly latencyP95Us: number;
  readonly latencyP99Us: number;
  readonly statusCodeCounts: bigint[];
  readonly inflightMax: number;
}

export interface MockComponentSummary {
  readonly component: string;
  readonly digestsReceived: bigint;
  readonly digestsDropped: bigint;
  readonly lastDigestUs: bigint;
  readonly inboundRows: bigint;
  readonly outboundRows: bigint;
}

/** Which services carry telemetry, and the methods each reports. */
interface ComponentMethods {
  readonly component: string;
  readonly methods: readonly { name: string; kind: number }[];
}

/**
 * The per-component method table, derived once from the descriptors.
 *
 * Dynamic-target catalog entries are skipped: `Admin` is served by every
 * Component rather than being one, and `EdgeApplication` belongs to an Edge
 * process that is a client, not a registered component.
 */
function buildComponentMethods(): ComponentMethods[] {
  return SERVICE_CATALOG.filter((e) => e.dynamicTarget !== true).map((entry) => ({
    component: entry.label,
    methods: methodsOf(entry).map((m) => ({ name: m.name, kind: rpcKindOf(m.kind) })),
  }));
}

const COMPONENT_METHODS: ComponentMethods[] = buildComponentMethods();

export interface TelemetryOptions {
  readonly seed: string;
  /** Wall-clock ms the fleet started from — snapshot timestamps hang off it. */
  readonly startedAtMs: number;
}

/**
 * The aggregated telemetry table.
 *
 * Values move with `tick` so a live panel shows a signal rather than a frozen
 * frame, and `reset()` is honoured per component because `Network.Reset` is an
 * operator action: a mock whose counters ignore a reset lets a "reset
 * telemetry" button look like it worked.
 */
export class MockTelemetry {
  private readonly seed: string;
  private readonly startedAtMs: number;
  /** Per component, the tick its counters were last zeroed at. */
  private readonly resetAt = new Map<string, number>();

  constructor(opts: TelemetryOptions) {
    this.seed = opts.seed;
    this.startedAtMs = opts.startedAtMs;
  }

  /** Every component the snapshot reports on. */
  components(): string[] {
    return COMPONENT_METHODS.map((c) => c.component);
  }

  /**
   * Zero a component's counters, or every component when `component` is empty
   * — matching `ResetRequest`, where an empty name means a global reset.
   */
  reset(component: string, tick: number): number {
    if (component === '') {
      for (const c of COMPONENT_METHODS) this.resetAt.set(c.component, tick);
      return COMPONENT_METHODS.length;
    }
    if (!COMPONENT_METHODS.some((c) => c.component === component)) return 0;
    this.resetAt.set(component, tick);
    return 1;
  }

  /** Ticks a component has been accumulating for, since start or last reset. */
  private elapsed(component: string, tick: number): number {
    return Math.max(0, tick - (this.resetAt.get(component) ?? 0));
  }

  rowsFor(component: string, tick: number): MockTelemetryRow[] {
    const entry = COMPONENT_METHODS.find((c) => c.component === component);
    if (!entry) return [];
    const since = this.elapsed(component, tick);

    return entry.methods.map((m) => {
      const key = `${component}.${m.name}`;
      // A streaming method carries messages; a unary one does not. Keeping the
      // distinction means the panel's msg/s column is empty exactly where a
      // real fleet leaves it empty.
      const streaming = m.kind !== RpcKindValue.UNARY;
      const rate = wave(tick, 0.2, 12, this.seed, key, 'rate');
      const bytesIn = wave(tick, 40, 4_200, this.seed, key, 'bin');
      const bytesOut = wave(tick, 60, 9_600, this.seed, key, 'bout');
      const p50 = intBetween(120, 2_400, this.seed, key, 'p50');

      const calls = BigInt(Math.round(rate * since));
      // Errors are a small, seeded minority — and PERMISSION_DENIED is broken
      // out because it is the observable consequence of an ejection.
      const denied = BigInt(Math.round(wave(tick, 0, 3, this.seed, key, 'denied')));
      const unavailable =
        unit(this.seed, key, 'flaky') > 0.85
          ? BigInt(Math.round(wave(tick, 0, 5, this.seed, key, 'unavail')))
          : 0n;
      const ok = calls > denied + unavailable ? calls - denied - unavailable : 0n;

      const counts = new Array<bigint>(STATUS_CODE_SLOTS).fill(0n);
      counts[STATUS_OK] = ok;
      counts[STATUS_PERMISSION_DENIED] = denied;
      counts[STATUS_UNAVAILABLE] = unavailable;

      return {
        component,
        name: m.name,
        kind: m.kind,
        direction: DirectionValue.INBOUND,
        callsTotal: calls,
        bytesInTotal: BigInt(Math.round(bytesIn * since)),
        bytesOutTotal: BigInt(Math.round(bytesOut * since)),
        bpsIn1s: bytesIn,
        bpsOut1s: bytesOut,
        msgRate1s: streaming ? rate : 0,
        latencyP50Us: p50,
        latencyP95Us: Math.round(p50 * 2.4),
        latencyP99Us: Math.round(p50 * 4.1),
        statusCodeCounts: counts,
        inflightMax: Math.round(wave(tick, 0, 4, this.seed, key, 'inflight')),
      };
    });
  }

  summaries(tick: number): MockComponentSummary[] {
    return COMPONENT_METHODS.map((c) => {
      const since = this.elapsed(c.component, tick);
      return {
        component: c.component,
        digestsReceived: BigInt(since),
        // A dropped digest is a real condition (publisher ring overflow during
        // a Network outage), so the seeded fleet contains one that drops.
        digestsDropped:
          unit(this.seed, c.component, 'drops') > 0.9
            ? BigInt(intBetween(1, 4, this.seed, c.component, 'ndrops'))
            : 0n,
        lastDigestUs: BigInt((this.startedAtMs + tick * 1000) * 1000),
        inboundRows: BigInt(c.methods.length),
        outboundRows: 0n,
      };
    });
  }

  /** One complete frame — every component, every row. No seq: there is none. */
  snapshot(tick: number): {
    snapshotAtUs: bigint;
    components: MockComponentSummary[];
    rows: MockTelemetryRow[];
  } {
    return {
      snapshotAtUs: BigInt((this.startedAtMs + tick * 1000) * 1000),
      components: this.summaries(tick),
      rows: COMPONENT_METHODS.flatMap((c) => this.rowsFor(c.component, tick)),
    };
  }
}
