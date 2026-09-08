/**
 * logs — the aggregated fleet log feed.
 *
 * The SeqResume contract, wired end to end: `StreamController` reconnects on
 * its own, and `resumeHeaders` hands back `salus-log-since-seq` built from the
 * last line seen, so the service replays from exactly there. No duplicates, no
 * gap, and no snapshot — the sequence IS the resume mechanism.
 */
import {
  LOG_SINCE_SEQ_HEADER,
  RingBuffer,
  StreamController,
  isFatalConnectError,
  type StreamControllerState,
} from '@salus-gui/streams';
import { networkClient } from '../clients.js';

export interface LogRow {
  seq: bigint;
  timestampUs: bigint;
  level: number;
  label: string;
  message: string;
  service: string;
}

/** Bounded: a live feed must not grow until the tab dies. */
const CAPACITY = 5_000;

/** `StreamLogs` takes `Salus.Common.Empty`; an empty object is its init shape. */
type EmptyRequest = Record<string, never>;

export class LogStore {
  private readonly ring = new RingBuffer<LogRow>(CAPACITY);
  private controller: StreamController<LogRow, EmptyRequest> | undefined;

  rows = $state<LogRow[]>([]);
  stream = $state<StreamControllerState>({ status: 'idle', attempt: 0, msgCount: 0 });
  /** Minimum level to show. Filtering happens here so the ring keeps everything. */
  minLevel = $state(1);

  private flushHandle: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    if (this.controller) {
      this.controller.start();
      return;
    }
    this.controller = new StreamController<LogRow, EmptyRequest>({
      label: 'network.StreamLogs',
      request: {} as EmptyRequest,
      open: (req, { signal, headers }) =>
        // The controller owns the signal and the resume headers; this just
        // hands them to the client.
        networkClient.streamLogs(req, { signal, headers }) as AsyncIterable<LogRow>,
      onMessage: (row) => {
        this.ring.push(row);
        this.scheduleFlush();
      },
      // Send the MAX SEQ SEEN, not seq+1. The producer's filter is exclusive
      // (`seq > since`), so asking for last+1 makes it skip the next line —
      // one line silently lost per reconnect. Pinned by the mock-salus
      // regression test "resumes with no gap and no duplicate".
      resumeHeaders: (last) => (last ? { [LOG_SINCE_SEQ_HEADER]: last.seq.toString() } : undefined),
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

  clear(): void {
    this.ring.clear();
    this.rows = [];
  }

  setMinLevel(level: number): void {
    this.minLevel = level;
    this.publish();
  }

  /**
   * Coalesce publishes to ~one frame. Lines arrive faster than the view can
   * paint, and assigning the array per line would re-render the whole console
   * for each one.
   */
  private scheduleFlush(): void {
    if (this.flushHandle !== undefined) return;
    this.flushHandle = setTimeout(() => {
      this.flushHandle = undefined;
      this.publish();
    }, 16);
  }

  private publish(): void {
    this.rows = this.ring.snapshot((r) => r.level >= this.minLevel);
  }
}

export const logs = new LogStore();
