/**
 * telemetry — `Network.StreamSuiteSnapshot`, the fleet's aggregated RPC table.
 *
 * **This feed is Resnapshot, not SeqResume, and that is a property of the
 * contract rather than a choice.** `SuiteSnapshot` carries no `seq` field and
 * `StreamSuiteSnapshotRequest` is empty: every frame is complete state, so a
 * reconnecting subscriber simply takes the next frame and replaces what it
 * held. There is no resume header to send, and nothing to resume from.
 *
 * The visible consequence, recorded in the design reference §7.8: anything
 * that would show a snapshot sequence number shows **age** instead. A seq
 * rendered here would be a number the console made up.
 */
import {
  SeriesBuffer,
  StreamController,
  isFatalConnectError,
  type StreamControllerState,
} from '@salus-gui/streams';
import { networkClient } from '../clients.js';

/** One (component, method) row of the aggregated table. */
export interface TelemetryRow {
  component: string;
  name: string;
  kind: number;
  direction: number;
  callsTotal: bigint;
  bytesInTotal: bigint;
  bytesOutTotal: bigint;
  bpsIn1s: number;
  bpsOut1s: number;
  msgRate1s: number;
  latencyP50Us: number;
  latencyP95Us: number;
  latencyP99Us: number;
  statusCodeCounts: bigint[];
  inflightMax: number;
}

export interface SnapshotFrame {
  snapshotAtUs: bigint;
  components: { component: string; digestsReceived: bigint; digestsDropped: bigint }[];
  rows: TelemetryRow[];
}

/** Per-component roll-up the topology chips render. */
export interface ComponentTelemetry {
  component: string;
  /** Σ msg_rate_1s across inbound rows — the chip's RPC/s spark. */
  rpcPerSecond: number;
  /** Σ bytes in + out per second — the chip's I/O spark. */
  bytesPerSecond: number;
  callsTotal: bigint;
  errors: bigint;
  denied: bigint;
  digestsDropped: bigint;
}

/** gRPC status slots the console breaks out by name. */
const STATUS_OK = 0;
const STATUS_PERMISSION_DENIED = 7;

/** 32 samples at 1 Hz — the window the chip sparklines draw. */
const SPARK_SAMPLES = 32;

/** `StreamSuiteSnapshot` takes an empty request. */
type EmptyRequest = Record<string, never>;

export class TelemetryStore {
  private controller: StreamController<SnapshotFrame, EmptyRequest> | undefined;
  /** Per component: [rpc/s, bytes/s], oldest → newest. */
  private readonly series = new Map<string, SeriesBuffer>();

  rows = $state<TelemetryRow[]>([]);
  byComponent = $state<Map<string, ComponentTelemetry>>(new Map());
  stream = $state<StreamControllerState>({ status: 'idle', attempt: 0, msgCount: 0 });
  /** Wall-clock ms of the most recent frame — the footer renders its age. */
  lastFrameAt = $state<number | undefined>(undefined);
  /** Component name to scope the table to, or undefined for the whole fleet. */
  focus = $state<string | undefined>(undefined);

  start(): void {
    if (this.controller) {
      this.controller.start();
      return;
    }
    this.controller = new StreamController<SnapshotFrame, EmptyRequest>({
      label: 'network.StreamSuiteSnapshot',
      request: {} as EmptyRequest,
      open: (req, { signal, headers }) =>
        networkClient.streamSuiteSnapshot(req, { signal, headers }) as AsyncIterable<SnapshotFrame>,
      onMessage: (frame) => this.apply(frame),
      // No resumeHeaders on purpose: there is no seq on this feed. Supplying
      // one would be inventing a resume the platform does not offer.
      isFatal: isFatalConnectError,
      onStateChange: (s) => {
        this.stream = { ...s };
      },
    });
    this.controller.start();
  }

  async stop(): Promise<void> {
    await this.controller?.stop();
  }

  setFocus(component: string | undefined): void {
    this.focus = component;
  }

  /** Sparkline columns for one component: `[xs, rpcPerSecond, bytesPerSecond]`. */
  sparksFor(component: string): { rpc: number[]; io: number[] } {
    const buf = this.series.get(component);
    if (!buf) return { rpc: [], io: [] };
    const [, rpc, io] = buf.toColumns();
    return { rpc: rpc ?? [], io: io ?? [] };
  }

  /**
   * Replace held state with the frame.
   *
   * A whole-frame replace is the correct reconcile for this feed: a component
   * that stops reporting must disappear from the table rather than linger at
   * its last values, which is precisely what merging frames would do.
   */
  private apply(frame: SnapshotFrame): void {
    const dropped = new Map(frame.components.map((c) => [c.component, c.digestsDropped]));
    const roll = new Map<string, ComponentTelemetry>();

    for (const row of frame.rows) {
      const acc = roll.get(row.component) ?? {
        component: row.component,
        rpcPerSecond: 0,
        bytesPerSecond: 0,
        callsTotal: 0n,
        errors: 0n,
        denied: 0n,
        digestsDropped: dropped.get(row.component) ?? 0n,
      };
      acc.rpcPerSecond += row.msgRate1s;
      acc.bytesPerSecond += row.bpsIn1s + row.bpsOut1s;
      acc.callsTotal += row.callsTotal;
      acc.denied += row.statusCodeCounts[STATUS_PERMISSION_DENIED] ?? 0n;
      // Everything that is not OK is an error, denials included — the panel
      // shows both because a denial is a different operator story.
      const ok = row.statusCodeCounts[STATUS_OK] ?? 0n;
      acc.errors += row.callsTotal > ok ? row.callsTotal - ok : 0n;
      roll.set(row.component, acc);
    }

    const at = Number(frame.snapshotAtUs / 1000n);
    for (const [component, acc] of roll) {
      let buf = this.series.get(component);
      if (!buf) {
        buf = new SeriesBuffer(2, SPARK_SAMPLES);
        this.series.set(component, buf);
      }
      buf.push(at, [acc.rpcPerSecond, acc.bytesPerSecond]);
    }
    // Drop series for components no longer reported, so a restarted fleet does
    // not keep drawing a chip's history under a name that has gone.
    for (const key of [...this.series.keys()]) {
      if (!roll.has(key)) this.series.delete(key);
    }

    this.rows = frame.rows;
    this.byComponent = roll;
    this.lastFrameAt = Date.now();
  }
}

export const telemetry = new TelemetryStore();
