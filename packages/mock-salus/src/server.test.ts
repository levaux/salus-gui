import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { Admin } from '@salus-gui/proto/gen/Admin_pb.js';
import { Network } from '@salus-gui/proto/gen/Network_pb.js';
import { Session } from '@salus-gui/proto/gen/Session_pb.js';
import { ADMIN_TARGET_HEADER, LOG_SINCE_SEQ_HEADER } from './headers.js';
import { startMockServer, type RunningMock } from './server.js';

/**
 * End to end over a real socket, with a real gRPC client — the same
 * `createGrpcTransport` the bridge uses. This is what makes "the same code
 * connects to the real fleet unchanged" a tested claim rather than an
 * intention: if the mock only ever answered in-process calls, the wire could
 * be wrong in ways no unit test would see.
 */
let running: RunningMock;
let transport: ReturnType<typeof createGrpcTransport>;

beforeAll(async () => {
  // Port 0 lets the OS pick a free one, so the suite never collides with a
  // developer's running `pnpm dev:mock`.
  running = await startMockServer({ port: 0, seed: 'e2e', frameMs: 0 });
  transport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${running.port}` });
});

afterAll(async () => {
  await running.close();
});

describe('over the wire', () => {
  it('answers Admin for the targeted service', async () => {
    const admin = createClient(Admin, transport);
    const status = await admin.getStatus({}, { headers: { [ADMIN_TARGET_HEADER]: 'Therapy' } });
    expect(status.serviceName).toBe('Therapy');
    expect(status.listenPort).toBe(57040);

    const other = await admin.getStatus({}, { headers: { [ADMIN_TARGET_HEADER]: 'Session' } });
    expect(other.serviceName).toBe('Session');
  });

  it('carries int64 fields as bigint', async () => {
    const admin = createClient(Admin, transport);
    const metrics = await admin.getMetrics({}, { headers: { [ADMIN_TARGET_HEADER]: 'Network' } });
    // rpc_count is int64. If this ever arrives as a number, precision is being
    // lost somewhere in the transport configuration.
    expect(typeof metrics.rpcCount).toBe('bigint');
  });

  it('serves the registry', async () => {
    const network = createClient(Network, transport);
    const reg = await network.getRegistryStatus({});
    expect(reg.registered).toBe(6);
    expect(reg.entries.map((e) => e.serviceName)).toContain('Protocol');
  });

  it('streams logs and resumes from a seq', async () => {
    const network = createClient(Network, transport);

    const first: bigint[] = [];
    const ac1 = new AbortController();
    for await (const row of network.streamLogs({}, { signal: ac1.signal })) {
      first.push(row.seq);
      if (first.length === 5) break; // the stream stays open; take a prefix
    }
    ac1.abort();
    expect(first).toHaveLength(5);

    const resumeFrom = first[4]!;
    const second: bigint[] = [];
    const ac2 = new AbortController();
    for await (const row of network.streamLogs(
      {},
      { signal: ac2.signal, headers: { [LOG_SINCE_SEQ_HEADER]: resumeFrom.toString() } },
    )) {
      second.push(row.seq);
      if (second.length === 3) break;
    }
    ac2.abort();

    // Exactly the resume contract: strictly newer, no duplicate, no gap.
    expect(second[0]).toBe(resumeFrom + 1n);
    expect(second.some((s) => s <= resumeFrom)).toBe(false);
  });

  it('ejects a session and the roster reflects it', async () => {
    const session = createClient(Session, transport);
    const before = await session.listSessions({ includeClosed: false });
    const victim = before.sessions[0]!;

    const res = await session.ejectSession({
      target: { case: 'jti', value: victim.jti },
      reason: 'wire test',
    });
    expect(res.ejected).toBe(true);
    expect(res.sessionsRevoked).toBe(1);

    const after = await session.listSessions({ includeClosed: false });
    expect(after.sessions.some((s) => s.jti === victim.jti)).toBe(false);

    const withClosed = await session.listSessions({ includeClosed: true });
    expect(withClosed.sessions.find((s) => s.jti === victim.jti)?.revoked).toBe(true);
  });

  it('a bound listener answers AS its service, ignoring the header', async () => {
    // Fidelity that matters: on a real fleet each Component serves Admin for
    // itself, and the bridge reaches a specific one by DIALLING ITS ADDRESS —
    // stripping the routing header on the way, because upstream it means
    // nothing. A mock answering from the header would report the wrong process
    // for every per-service drawer, and only against a real fleet would anyone
    // notice.
    const multi = await startMockServer({ port: 0, seed: 'bound', frameMs: 0 });
    await multi.close();

    // Bind the real rebased set and dial Session's own port with a header
    // naming a different service; the port must win.
    const fleet = await startMockServer({ seed: 'bound', frameMs: 0 });
    try {
      const sessionPort = fleet.ports[2]!; // 57020 → base+20
      const client = createClient(
        Admin,
        createGrpcTransport({ baseUrl: `http://127.0.0.1:${sessionPort}` }),
      );
      const status = await client.getStatus({}, { headers: { [ADMIN_TARGET_HEADER]: 'Therapy' } });
      expect(status.serviceName).toBe('Session');
      expect(status.listenPort).toBe(57020);
    } finally {
      await fleet.close();
    }
  });

  it('reports NOT_FOUND for an unknown Admin target', async () => {
    const admin = createClient(Admin, transport);
    await expect(
      admin.getStatus({}, { headers: { [ADMIN_TARGET_HEADER]: 'NoSuchService' } }),
    ).rejects.toThrow(/not_found|no such service/i);
  });
});
