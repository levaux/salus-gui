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

    // Bind a rebased set and dial Session's own port with a header naming a
    // different service; the port must win.
    //
    // A dedicated base port, NOT the 56800 default: this test needs a real
    // rebased set (base, base+10 … base+50) rather than port 0, and binding the
    // default made the suite fail with EADDRINUSE whenever a developer had
    // `./infra/up.sh` running. A test that breaks because the dev stack is up
    // trains people to ignore it.
    const fleet = await startMockServer({ port: 56900, seed: 'bound', frameMs: 0 });
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

  it('resumes the log stream with no gap and no duplicate', async () => {
    // The regression this pins: `salus-log-since-seq` is EXCLUSIVE on the
    // producer side (`seq > since`), so a subscriber resumes by sending the
    // MAX SEQ IT SAW. The console originally sent last+1, which asked the
    // producer to skip the very next line — one line lost per reconnect, with
    // nothing in the UI to show for it. Verified here over the wire because
    // the header is the whole contract.
    const network = createClient(Network, transport);

    const seen: bigint[] = [];
    const first = new AbortController();
    for await (const row of network.streamLogs({}, { signal: first.signal })) {
      seen.push(row.seq);
      if (seen.length === 4) {
        first.abort();
        break;
      }
    }
    const maxSeen = seen[seen.length - 1]!;

    const resumed: bigint[] = [];
    const second = new AbortController();
    for await (const row of network.streamLogs(
      {},
      { signal: second.signal, headers: { [LOG_SINCE_SEQ_HEADER]: maxSeen.toString() } },
    )) {
      resumed.push(row.seq);
      if (resumed.length === 3) {
        second.abort();
        break;
      }
    }

    // Contiguous across the reconnect boundary: the first resumed line is the
    // one immediately after the last seen, and nothing repeats.
    expect(resumed[0]).toBe(maxSeen + 1n);
    expect(resumed).toEqual([maxSeen + 1n, maxSeen + 2n, maxSeen + 3n]);
    expect(seen.some((s) => resumed.includes(s))).toBe(false);
  });

  it('streams SuiteSnapshot as repeated complete frames', async () => {
    // The snapshot feed is Resnapshot, not SeqResume: each frame is whole
    // state. Proving that over the wire matters because the console's
    // reconnect path for this feed is "take the next frame" — there is no seq
    // to resume from, and a stream that only emitted once would leave a
    // reconnecting panel waiting forever for an update that never comes.
    const network = createClient(Network, transport);
    const frames: { components: number; rows: number }[] = [];
    const ac = new AbortController();

    for await (const frame of network.streamSuiteSnapshot({}, { signal: ac.signal })) {
      frames.push({ components: frame.components.length, rows: frame.rows.length });
      if (frames.length === 3) {
        ac.abort();
        break;
      }
    }

    expect(frames).toHaveLength(3);
    // Every frame complete, and identically shaped — not deltas.
    expect(frames[1]).toEqual(frames[0]);
    expect(frames[2]).toEqual(frames[0]);
    expect(frames[0]!.components).toBe(6);
    expect(frames[0]!.rows).toBeGreaterThan(6);
  });

  it('a snapshot row carries the real method name and a bigint total', async () => {
    const network = createClient(Network, transport);
    const snap = await network.getSuiteSnapshot({});
    const row = snap.rows.find((r) => r.component === 'Network' && r.name === 'StreamLogs');
    expect(row).toBeDefined();
    // calls_total is uint64 — arriving as a number would mean precision loss
    // in the transport for exactly the counters an operator watches climb.
    expect(typeof row!.callsTotal).toBe('bigint');
    expect(snap.snapshotAtUs).toBeGreaterThan(0n);
  });
});
