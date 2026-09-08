/**
 * lifecycle — `Network.StreamLifecycleEvents`.
 *
 * The feed that makes a status change *instant* rather than something a panel
 * discovers on its next poll. The registry poll is the authority for what is
 * registered; this is how the console learns a service started, stopped or
 * reconnected in between.
 *
 * SeqResume, like the log feed: `LifecycleEvent.seq` is Network-side monotonic
 * and the subscriber resumes by sending **the max seq it saw** via
 * `salus-lifecycle-since-seq`. The producer filter is exclusive (`seq > since`),
 * so sending last+1 would skip an event — see the regression test in
 * mock-salus, "resumes the log stream with no gap and no duplicate".
 */
import {
  LIFECYCLE_SINCE_SEQ_HEADER,
  RingBuffer,
  StreamController,
  isFatalConnectError,
  type StreamControllerState,
} from '@salus-gui/streams';
import { networkClient } from '../clients.js';

export interface LifecycleRow {
  seq: bigint;
  timestamp?: { seconds: bigint; nanos: number };
  serviceName: string;
  eventType: string;
  message: string;
  status: number;
}

/** Bounded — a console left open overnight must not accumulate without limit. */
const CAPACITY = 2_000;

type EmptyRequest = Record<string, never>;

export class LifecycleStore {
  private readonly ring = new RingBuffer<LifecycleRow>(CAPACITY);
  private controller: StreamController<LifecycleRow, EmptyRequest> | undefined;
  private flushHandle: ReturnType<typeof setTimeout> | undefined;

  rows = $state<LifecycleRow[]>([]);
  stream = $state<StreamControllerState>({ status: 'idle', attempt: 0, msgCount: 0 });

  start(): void {
    if (this.controller) {
      this.controller.start();
      return;
    }
    this.controller = new StreamController<LifecycleRow, EmptyRequest>({
      label: 'network.StreamLifecycleEvents',
      request: {} as EmptyRequest,
      open: (req, { signal, headers }) =>
        networkClient.streamLifecycleEvents(req, {
          signal,
          headers,
        }) as AsyncIterable<LifecycleRow>,
      onMessage: (row) => {
        this.ring.push(row);
        this.scheduleFlush();
      },
      resumeHeaders: (last) =>
        last ? { [LIFECYCLE_SINCE_SEQ_HEADER]: last.seq.toString() } : undefined,
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

  /** The most recent events, newest first — how the feed reads in a panel. */
  latest(n: number): LifecycleRow[] {
    return this.rows.slice(-n).reverse();
  }

  /** One service's slice, for the Inspector. */
  forService(name: string): LifecycleRow[] {
    return this.rows.filter((r) => r.serviceName === name).reverse();
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== undefined) return;
    this.flushHandle = setTimeout(() => {
      this.flushHandle = undefined;
      this.rows = this.ring.snapshot();
    }, 16);
  }
}

export const lifecycle = new LifecycleStore();
