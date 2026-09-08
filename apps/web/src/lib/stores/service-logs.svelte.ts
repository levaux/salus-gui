/**
 * service-logs — one service's own `Admin.StreamLogs`, for the Inspector.
 *
 * Distinct from the aggregated feed on purpose. `Network.StreamLogs` is the
 * fleet's merged view and depends on Network being up and forwarding; this
 * dials the Component directly through the bridge, so a service's own log
 * remains readable when the aggregator is the thing that is broken. That is
 * precisely when an operator most wants it.
 *
 * SeqResume, with the same exclusive-filter contract as the aggregate: resume
 * by sending the max seq seen, never last+1.
 */
import {
  ADMIN_TARGET_HEADER,
  LOG_SINCE_SEQ_HEADER,
  RingBuffer,
  StreamController,
  isFatalConnectError,
  type StreamControllerState,
} from '@salus-gui/streams';
import { adminClient } from '../clients.js';

export interface ServiceLogRow {
  seq: bigint;
  timestampUs: bigint;
  level: number;
  label: string;
  message: string;
}

/** Smaller than the fleet ring: this is a drawer, not the log console. */
const CAPACITY = 500;

type EmptyRequest = Record<string, never>;

export class ServiceLogStore {
  private readonly ring = new RingBuffer<ServiceLogRow>(CAPACITY);
  private controller: StreamController<ServiceLogRow, EmptyRequest> | undefined;
  private address: string | undefined;
  private flushHandle: ReturnType<typeof setTimeout> | undefined;

  rows = $state<ServiceLogRow[]>([]);
  stream = $state<StreamControllerState>({ status: 'idle', attempt: 0, msgCount: 0 });

  /**
   * Point the feed at a service, or at nothing.
   *
   * Switching services tears the old stream down and clears the ring: showing
   * one service's lines under another's heading is the same class of error as
   * a superseded fetch rendering under the wrong selection.
   */
  async follow(address: string | undefined): Promise<void> {
    if (address === this.address) return;
    this.address = address;
    await this.controller?.stop();
    this.controller = undefined;
    this.ring.clear();
    this.rows = [];
    this.stream = { status: 'idle', attempt: 0, msgCount: 0 };
    if (address === undefined || address === '') return;

    this.controller = new StreamController<ServiceLogRow, EmptyRequest>({
      label: `admin.StreamLogs(${address})`,
      request: {} as EmptyRequest,
      open: (req, { signal, headers }) => {
        // The routing header rides alongside whatever resume header the
        // controller built — both are just metadata on the same call.
        const merged = new Headers(headers);
        merged.set(ADMIN_TARGET_HEADER, address);
        return adminClient.streamLogs(req, {
          signal,
          headers: merged,
        }) as AsyncIterable<ServiceLogRow>;
      },
      onMessage: (row) => {
        this.ring.push(row);
        this.scheduleFlush();
      },
      resumeHeaders: (last) => (last ? { [LOG_SINCE_SEQ_HEADER]: last.seq.toString() } : undefined),
      isFatal: isFatalConnectError,
      onStateChange: (s) => {
        this.stream = { ...s };
      },
    });
    this.controller.start();
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== undefined) return;
    this.flushHandle = setTimeout(() => {
      this.flushHandle = undefined;
      this.rows = this.ring.snapshot();
    }, 16);
  }
}

export const serviceLogs = new ServiceLogStore();
