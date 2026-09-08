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
import type { Http2Server, ServerHttp2Session } from 'node:http2';

import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';

import { Admin } from '@salus-gui/proto/gen/Admin_pb.js';
import { Network } from '@salus-gui/proto/gen/Network_pb.js';
import { Session } from '@salus-gui/proto/gen/Session_pb.js';
import { CATALOG_PORT_BASE, SERVICE_CATALOG } from '@salus-gui/proto/services';

import { MockFleet } from './fleet.js';
import { MockRouter, type Ctx } from './router.js';
import { LIFECYCLE_SINCE_SEQ_HEADER, LOG_SINCE_SEQ_HEADER } from './headers.js';
import { ScriptedStream, realClock, type ScriptedFrame } from './scripted-stream.js';
import { MockTelemetry } from './telemetry.js';

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

/**
 * Emit a fresh frame every `periodMs` until the client goes away.
 *
 * Distinct from `replayThenIdle` on purpose: a snapshot feed has no backlog to
 * replay and no sequence to resume from. Each frame is complete state, so the
 * only thing a subscriber can do on reconnect is take the next one — which is
 * why this generator produces rather than replays.
 */
async function* repeatSnapshot<T>(
  produce: () => T,
  signal: AbortSignal,
  periodMs: number,
): AsyncGenerator<T> {
  const clock = realClock;
  while (!signal.aborted) {
    yield produce();
    try {
      await clock.sleep(periodMs, signal);
    } catch {
      return; // aborted mid-sleep: the subscriber left
    }
  }
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
      shutdown: (_req, c) => mock.shutdown(asCtx(c)),
      setTrace: (req, c) => mock.setLogFlag(asCtx(c), 'trace', req.enabled),
      setDebug: (req, c) => mock.setLogFlag(asCtx(c), 'debug', req.enabled),
      getConfig: (req, c) => mock.getConfig(asCtx(c), req.redactSecrets),
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
      drainAll: () => mock.drainAll(),
      shutdownAll: () => mock.shutdownAll(),
      getSuiteSnapshot: (req) => mock.suiteSnapshot(req.resetAfterReturn),
      reset: (req) => {
        mock.resetTelemetry(req.componentName);
        return {};
      },
      // 1 Hz by default, matching the platform's publisher cadence. No resume
      // header is read: SuiteSnapshot carries no seq (see telemetry.ts).
      streamSuiteSnapshot: (_req, c) =>
        repeatSnapshot(() => mock.suiteSnapshot(), c.signal, Math.max(frameMs, 1)),
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
  /** The base port — the one a site's `portBase` should name. */
  readonly port: number;
  /** Every port bound, one per distinct rebased catalog port. */
  readonly ports: number[];
  readonly fleet: MockFleet;
  close(): Promise<void>;
}

/**
 * Start the hub.
 *
 * **One listener per rebased catalog port, all sharing one handler.** The
 * bridge rebases each service independently (`portBase + (catalogPort -
 * 57000)`), so Session arrives at base+20 and Therapy at base+40. A single
 * listener would answer only the service whose offset is zero, and every other
 * panel would see ECONNREFUSED — which is exactly what happened the first time
 * this was wired up. Binding the whole rebased set keeps the mock a drop-in
 * substitute for a fleet of separate processes, which is the point of it.
 *
 * `port: 0` binds one OS-chosen port and serves everything there, for tests
 * that talk to it directly rather than through a rebasing bridge.
 */
export function startMockServer(opts: MockServerOptions = {}): Promise<RunningMock> {
  const basePort = opts.port ?? MOCK_HUB_PORT;
  const frameMs = opts.frameMs ?? 250;
  const fleetOpts = opts.seed !== undefined ? { seed: opts.seed } : {};
  const fleet = new MockFleet(fleetOpts);

  /**
   * One listener per service, each answering **as** that service.
   *
   * Dynamic-target entries (Admin, EdgeApplication) claim no listener: they are
   * always reached by an explicit address that rebases onto a real service's
   * port, and EdgeApplication's 58070 convention would otherwise bind a stray
   * port inside the platform's own band.
   *
   * The service name attached here is what makes Admin faithful. On a real
   * fleet every Component serves Admin for *itself*, and the bridge reaches a
   * specific one by dialling its address — stripping the routing header on the
   * way, because upstream it means nothing. A mock that answered from the
   * header would report the wrong process for every per-service drawer.
   */
  const bindings: { port: number; service: string | undefined }[] =
    basePort === 0
      ? [{ port: 0, service: undefined }]
      : [
          ...new Map(
            SERVICE_CATALOG.filter((e) => e.dynamicTarget !== true).map((e) => [
              basePort + (e.port - CATALOG_PORT_BASE),
              e.label,
            ]),
          ),
        ].map(([port, service]) => ({ port, service }));

  // Track live sessions across every listener so close() can forcibly drop
  // them. http2's close() only stops accepting new connections and waits for
  // existing sessions to end — one long-lived forwarded stream would keep a
  // session open forever, hanging teardown AND leaving the subscribed client
  // with no disconnect to recover from. Destroying sessions is what makes a
  // restart a real drop that a StreamController reconnects through.
  const sessions = new Set<ServerHttp2Session>();
  const servers: Http2Server[] = [];
  const telemetry = new MockTelemetry({ seed: fleet.seed, startedAtMs: fleet.startedAtMs });

  return (async (): Promise<RunningMock> => {
    const bound: number[] = [];
    for (const { port: listenPort, service } of bindings) {
      // One router per listener, all over the SAME fleet, so state an operator
      // changes through one service (an ejection, a drain) is visible through
      // every other.
      // One telemetry table shared by every listener. Network's snapshot is a
      // fleet-wide aggregate, so per-listener tables would let two panels
      // disagree about the same fleet — and a `Reset` through one would leave
      // the others counting.
      const routerOpts =
        service === undefined ? { fleet, telemetry } : { fleet, boundService: service, telemetry };
      const handler = connectNodeAdapter({
        routes: buildRoutes(new MockRouter(routerOpts), frameMs),
      });
      const server: Http2Server = createServer(
        { settings: { maxConcurrentStreams: 256 } },
        handler,
      );
      server.on('session', (session) => {
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      // Report the port actually bound: `port: 0` asks the OS to choose, and
      // handing the 0 back would send every caller to an unroutable address.
      bound.push(typeof address === 'object' && address !== null ? address.port : listenPort);
      servers.push(server);
    }

    return {
      port: bound[0]!,
      ports: bound,
      fleet,
      close: () =>
        new Promise<void>((resolve) => {
          for (const session of sessions) session.destroy();
          sessions.clear();
          let remaining = servers.length;
          for (const server of servers) {
            server.close(() => {
              if (--remaining === 0) resolve();
            });
          }
        }),
    };
  })();
}
