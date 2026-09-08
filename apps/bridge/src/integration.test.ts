import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, Code, ConnectError } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { Admin } from '@salus-gui/proto/gen/Admin_pb.js';
import { Network } from '@salus-gui/proto/gen/Network_pb.js';
import { Session } from '@salus-gui/proto/gen/Session_pb.js';
import { startMockServer, type RunningMock } from '@salus-gui/mock-salus';

import { AuditLog } from './audit.js';
import { createBridge } from './main.js';
import { KvStore } from './kv.js';
import { SiteContext, type Site } from './services.js';

/**
 * The whole path, end to end: a Connect client (as the browser is) → the
 * bridge over h2/TLS → the mock fleet over h2c gRPC → back.
 *
 * This is the test that actually exercises the bridge's reason for existing.
 * The unit tests cover each guard in isolation; only this one proves the
 * header hygiene, the transport re-encoding, the per-Component routing and the
 * streaming pipe work together on a real socket.
 */
let mock: RunningMock;
let bridgePort: number;
let site: SiteContext;
let audit: AuditLog;
let dir: string;
let close: () => Promise<void>;
let transport: ReturnType<typeof createConnectTransport>;

/**
 * The mock binds a *set* of rebased ports, so it needs a base rather than an
 * OS-chosen one — and the suite must not collide with a developer's running
 * `pnpm dev:mock`, or with a parallel run of itself. Try a few random bases
 * well clear of the console's own 56400/56800 and the platform's 57xxx/58xxx.
 */
async function startOnFreeBase(): Promise<RunningMock> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    const base = 40_000 + Math.floor(Math.random() * 5_000) * 2;
    try {
      return await startMockServer({ port: base, seed: 'integration', frameMs: 0 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'salus-bridge-it-'));

  // A throwaway self-signed cert: the bridge refuses to start without TLS, and
  // that refusal is deliberate (browsers only multiplex h2 over TLS).
  const certDir = join(dir, 'certs');
  execFileSync('mkdir', ['-p', certDir]);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(certDir, 'bridge-key.pem'),
      '-out',
      join(certDir, 'bridge.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );

  mock = await startOnFreeBase();

  const siteDef: Site = {
    id: 'it',
    name: 'Integration',
    env: 'mock',
    services: { host: '127.0.0.1', portBase: mock.port },
  };
  site = new SiteContext(siteDef);
  audit = new AuditLog({ capacity: 100 });

  const { readFileSync } = await import('node:fs');
  const server = createBridge({
    site,
    audit,
    kv: new KvStore(join(dir, 'kv')),
    tls: {
      key: readFileSync(join(certDir, 'bridge-key.pem')),
      cert: readFileSync(join(certDir, 'bridge.pem')),
    },
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      bridgePort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  transport = createConnectTransport({
    baseUrl: `https://127.0.0.1:${bridgePort}/rpc`,
    httpVersion: '2',
    nodeOptions: { rejectUnauthorized: false }, // the throwaway cert
  });
});

afterAll(async () => {
  await close?.();
  await mock?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('browser → bridge → fleet', () => {
  it("forwards a unary call and returns the fleet's answer", async () => {
    const network = createClient(Network, transport);
    const reg = await network.getRegistryStatus({});
    expect(reg.registered).toBe(6);
    expect(reg.entries.map((e) => e.serviceName)).toContain('Therapy');
  });

  it('routes an Admin call to the Component the target names', async () => {
    // The bridge resolves the target to an address, dials it, and strips the
    // header; the mock listener answers as the service it fronts.
    const admin = createClient(Admin, transport);
    const therapy = await admin.getStatus(
      {},
      { headers: { 'salus-admin-target': '127.0.0.1:57040' } },
    );
    expect(therapy.serviceName).toBe('Therapy');

    const health = await admin.getStatus(
      {},
      { headers: { 'salus-admin-target': '127.0.0.1:57030' } },
    );
    expect(health.serviceName).toBe('Health');
  });

  it('refuses an admin target outside the site — not an open proxy', async () => {
    const admin = createClient(Admin, transport);
    await expect(
      admin.getStatus({}, { headers: { 'salus-admin-target': 'evil.example.com:80' } }),
    ).rejects.toThrow(/not allowed/);
  });

  it('pipes a server stream and honours seq resume across the bridge', async () => {
    const network = createClient(Network, transport);

    const first: bigint[] = [];
    const ac1 = new AbortController();
    for await (const row of network.streamLogs({}, { signal: ac1.signal })) {
      first.push(row.seq);
      if (first.length === 4) break;
    }
    ac1.abort();

    const resumeFrom = first[3]!;
    const second: bigint[] = [];
    const ac2 = new AbortController();
    for await (const row of network.streamLogs(
      {},
      { signal: ac2.signal, headers: { 'salus-log-since-seq': resumeFrom.toString() } },
    )) {
      second.push(row.seq);
      if (second.length === 2) break;
    }
    ac2.abort();

    // The resume header crossed the bridge verbatim — no special-casing there.
    expect(second[0]).toBe(resumeFrom + 1n);
  });

  it('preserves int64 as bigint through both hops', async () => {
    const admin = createClient(Admin, transport);
    const metrics = await admin.getMetrics(
      {},
      { headers: { 'salus-admin-target': '127.0.0.1:57000' } },
    );
    expect(typeof metrics.rpcCount).toBe('bigint');
  });

  it('propagates an upstream error with its code intact', async () => {
    const admin = createClient(Admin, transport);
    try {
      await admin.getStatus({}, { headers: { 'salus-admin-target': '127.0.0.1:59999' } });
      throw new Error('expected a failure');
    } catch (err) {
      // Unreachable upstream — the browser must see a real Connect error, not
      // a bare HTTP status.
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.Unavailable);
    }
  });

  it('refuses every mutating RPC when read-only is on, and still serves reads', async () => {
    const session = createClient(Session, transport);
    const before = await session.listSessions({ includeClosed: false });
    expect(before.sessions.length).toBeGreaterThan(0);

    site.readOnly = true;
    try {
      await expect(
        session.ejectSession({
          target: { case: 'jti', value: before.sessions[0]!.jti },
          reason: 'should refuse',
        }),
      ).rejects.toThrow(/read-only/);

      // Reads keep working — the switch makes the console observe-only, not
      // useless.
      const during = await session.listSessions({ includeClosed: false });
      expect(during.sessions).toHaveLength(before.sessions.length);
    } finally {
      site.readOnly = false;
    }

    // And with the switch off, the same call goes through.
    const res = await session.ejectSession({
      target: { case: 'jti', value: before.sessions[0]!.jti },
      reason: 'allowed now',
    });
    expect(res.ejected).toBe(true);
  });

  it('audits what it forwarded', async () => {
    const network = createClient(Network, transport);
    await network.getRegistryStatus({});
    await audit.flush();

    const entry = audit.recent().find((e) => e.rpc === 'GetRegistryStatus');
    expect(entry).toBeDefined();
    expect(entry!.site).toBe('it');
    expect(entry!.outcome).toBe('ok');
    // Reads are audited too: knowing which reads preceded a mutation is most
    // of what makes the trail readable.
    expect(entry!.mutating).toBe(false);

    const eject = audit.recent().find((e) => e.rpc === 'EjectSession');
    expect(eject?.mutating).toBe(true);
  });
});
