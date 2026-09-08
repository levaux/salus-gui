/**
 * server — the mock-salus hub.
 *
 * One Connect-Node router over cleartext HTTP/2 (h2c — no TLS, mirroring the
 * platform's own plaintext internal gRPC listeners). `connectNodeAdapter`
 * answers the Connect, gRPC and gRPC-Web wire protocols on the same routes with
 * no extra configuration, which is what lets the bridge's real
 * `createGrpcTransport` talk to this mock unmodified. Pointing a site at the
 * mock or at a live fleet is then a host/port change and nothing else.
 *
 * **One listener, the whole catalog.** The bridge rebases every catalog port
 * onto this hub (`port = portBase + (catalogPort - 57000)`), so a single
 * process answers Network, Admin, Session and the rest. That is why the router
 * dispatches on the *service* rather than on which port a call arrived at.
 */
import { createServer } from 'node:http2';
import type { Http2Server } from 'node:http2';

import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';

import { Admin } from '@salus-gui/proto/gen/Admin_pb.js';
import { Network } from '@salus-gui/proto/gen/Network_pb.js';
import { Session } from '@salus-gui/proto/gen/Session_pb.js';

import { MockFleet } from './fleet.js';
import { MockRouter, type Ctx } from './router.js';
import { LIFECYCLE_SINCE_SEQ_HEADER, LOG_SINCE_SEQ_HEADER } from './headers.js';
import { ScriptedStream, type ScriptedFrame } from './scripted-stream.js';

/** The hub's default port — outside the Salus 57xxx/58xxx bands. */
export const MOCK_HUB_PORT = 56800;

const asCtx = (c: HandlerContext): Ctx => ({ header: c.requestHeader, signal: c.signal });

/**
 * Replay a list of already-resumed rows as a live stream, then keep the stream
 * open. A log stream that ends after its backlog would make every console panel
 * reconnect in a loop, which is not what a live feed does.
 */
async function* replayThenIdle<T>(
  rows: readonly T[],
  signal: AbortSignal,
  frameMs: number,
): AsyncGenerator<T> {
  const frames: ScriptedFrame<T>[] = rows.map((data, i) => ({ atMs: i * frameMs, data }));
  for await (const row of new ScriptedStream({ frames }).play(signal)) yield row;
  // Hold the stream open until the client goes away.
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export interface MockServerOptions {
  port?: number;
  seed?: string;
  /** Delay between replayed stream frames, ms. 0 replays as fast as possible. */
  frameMs?: number;
}

export function buildRoutes(mock: MockRouter, frameMs: number) {
  return (router: ConnectRouter): void => {
    router.service(Admin, {
      ping: () => mock.ping(),
      getStatus: (_req, c) => mock.getStatus(asCtx(c)),
      getMetrics: (_req, c) => mock.getMetrics(asCtx(c)),
      drain: (_req, c) => mock.drain(asCtx(c)),
      streamLogs: (_req, c) =>
        replayThenIdle(
          mock.adminLogs(asCtx(c), LOG_SINCE_SEQ_HEADER).map((l) => ({
            timestampUs: l.timestampUs,
            level: l.level,
            label: l.label,
            message: l.message,
            seq: l.seq,
          })),
          c.signal,
          frameMs,
        ),
    });

    router.service(Network, {
      getRegistryStatus: () => mock.getRegistryStatus(),
      getAllStatus: () => mock.getAllStatus(),
      getAllMetrics: () => mock.getAllMetrics(),
      streamLogs: (_req, c) =>
        replayThenIdle(
          mock.networkLogs(asCtx(c), LOG_SINCE_SEQ_HEADER).map((l) => ({
            serviceName: l.service,
            adminAddress: '127.0.0.1:57000',
            receivedAtUs: l.timestampUs,
            timestampUs: l.timestampUs,
            level: l.level,
            label: l.label,
            message: l.message,
            seq: l.seq,
          })),
          c.signal,
          frameMs,
        ),
      streamLifecycleEvents: (_req, c) =>
        replayThenIdle(
          mock.lifecycleEvents(asCtx(c), LIFECYCLE_SINCE_SEQ_HEADER),
          c.signal,
          frameMs,
        ),
    });

    router.service(Session, {
      listSessions: (req) => mock.listSessions({ includeClosed: req.includeClosed }),
      ejectSession: (req) => {
        const target: { subject?: string; jti?: string; reason?: string } = {
          reason: req.reason,
        };
        // `target` is a proto oneof: exactly one of subject/jti is set.
        if (req.target?.case === 'subject') target.subject = req.target.value;
        if (req.target?.case === 'jti') target.jti = req.target.value;
        return mock.ejectSession(target);
      },
    });
  };
}

export interface RunningMock {
  readonly port: number;
  readonly fleet: MockFleet;
  close(): Promise<void>;
}

export function startMockServer(opts: MockServerOptions = {}): Promise<RunningMock> {
  const port = opts.port ?? MOCK_HUB_PORT;
  const frameMs = opts.frameMs ?? 250;
  const fleetOpts = opts.seed !== undefined ? { seed: opts.seed } : {};
  const fleet = new MockFleet(fleetOpts);
  const mock = new MockRouter({ fleet });

  const server: Http2Server = createServer(
    connectNodeAdapter({ routes: buildRoutes(mock, frameMs) }),
  );

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      // Report the port actually bound, not the one requested: `port: 0` asks
      // the OS to choose, and returning the 0 back would send every caller to
      // an unroutable address.
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        fleet,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Sessions that are merely idle keep `close` pending, which would
            // hang a test's teardown; drop them explicitly. Guarded because
            // the method is newer than this package's Node floor.
            const withClose = server as Http2Server & { closeAllConnections?: () => void };
            withClose.closeAllConnections?.();
          }),
      });
    });
  });
}
