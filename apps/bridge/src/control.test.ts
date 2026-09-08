import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { AuditLog } from './audit.js';
import { handleControl, type ControlRequest, type ControlResponse } from './control.js';
import { KvStore } from './kv.js';
import { SiteContext, type Site } from './services.js';

const SITE: Site = {
  id: 'test',
  name: 'Test',
  env: 'mock',
  services: { host: '127.0.0.1', portBase: 56800 },
};

/**
 * A response fake that RESOLVES A PROMISE when `end` is actually called, so a
 * test awaits real completion rather than sleeping. A fixed timeout before an
 * assertion passes locally and flakes on a slow runner.
 */
function fakeResponse(): ControlResponse & {
  done: Promise<{ status: number; body: string }>;
} {
  let status = 0;
  let settle: (v: { status: number; body: string }) => void;
  const done = new Promise<{ status: number; body: string }>((r) => (settle = r));
  return {
    done,
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(chunk?: string) {
      settle({ status, body: chunk ?? '' });
      return this;
    },
  } as ControlResponse & { done: Promise<{ status: number; body: string }> };
}

function fakeRequest(url: string, method = 'GET', body?: string): ControlRequest {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  return Object.assign(stream, { url, method }) as unknown as ControlRequest;
}

let dir: string;
let opts: { site: SiteContext; audit: AuditLog; kv: KvStore };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'salus-bridge-'));
  opts = {
    site: new SiteContext(SITE),
    audit: new AuditLog({ dir: join(dir, 'audit') }),
    kv: new KvStore(join(dir, 'kv')),
  };
});

afterEach(async () => {
  await opts.audit.flush();
  await rm(dir, { recursive: true, force: true });
});

describe('/bridge', () => {
  it('reports the site it is pointed at', async () => {
    const res = fakeResponse();
    expect(await handleControl(fakeRequest('/bridge/info'), res, opts)).toBe(true);
    const { status, body } = await res.done;
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ site: 'test', env: 'mock', readOnly: false });
  });

  it('flips read-only and records the flip', async () => {
    const put = fakeResponse();
    await handleControl(
      fakeRequest('/bridge/readonly', 'PUT', JSON.stringify({ readOnly: true })),
      put,
      opts,
    );
    expect((await put.done).status).toBe(200);
    expect(opts.site.readOnly).toBe(true);

    // Flipping the fleet-wide switch is itself an operator action.
    await opts.audit.flush();
    expect(opts.audit.recent().some((e) => e.rpc === 'EnterReadOnly')).toBe(true);
  });

  it('rejects a malformed read-only body', async () => {
    const res = fakeResponse();
    await handleControl(
      fakeRequest('/bridge/readonly', 'PUT', JSON.stringify({ readOnly: 'yes' })),
      res,
      opts,
    );
    expect((await res.done).status).toBe(400);
    expect(opts.site.readOnly).toBe(false);
  });

  it('serves the audit ring', async () => {
    await opts.audit.append({
      ts: Date.now(),
      site: 'test',
      service: 'Salus.Session.Session',
      rpc: 'EjectSession',
      argsHash: 'abc',
      outcome: 'ok',
      latencyMs: 3,
      mutating: true,
    });
    const res = fakeResponse();
    await handleControl(fakeRequest('/bridge/audit'), res, opts);
    const { body } = await res.done;
    expect(JSON.parse(body).entries[0]).toMatchObject({ rpc: 'EjectSession', mutating: true });
  });

  it('falls through for a path it does not own', async () => {
    // An unhandled path must reach the RPC adapter, not 404 here.
    expect(
      await handleControl(fakeRequest('/rpc/Salus.Admin.Admin/Ping'), fakeResponse(), opts),
    ).toBe(false);
  });
});

describe('/kv', () => {
  it('round-trips a document', async () => {
    const put = fakeResponse();
    await handleControl(
      fakeRequest('/kv/workspaces/desk-1', 'PUT', JSON.stringify({ panels: ['fleet'] })),
      put,
      opts,
    );
    expect((await put.done).status).toBe(204);

    const get = fakeResponse();
    await handleControl(fakeRequest('/kv/workspaces/desk-1'), get, opts);
    const { status, body } = await get.done;
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ panels: ['fleet'] });
  });

  it('lists a namespace, and an unknown one is empty rather than 404', async () => {
    await handleControl(fakeRequest('/kv/views/a', 'PUT', '{}'), fakeResponse(), opts);
    await handleControl(fakeRequest('/kv/views/b', 'PUT', '{}'), fakeResponse(), opts);

    const list = fakeResponse();
    await handleControl(fakeRequest('/kv/views'), list, opts);
    expect(JSON.parse((await list.done).body)).toEqual({ keys: ['a', 'b'] });

    const empty = fakeResponse();
    await handleControl(fakeRequest('/kv/nothing-here'), empty, opts);
    expect(JSON.parse((await empty.done).body)).toEqual({ keys: [] });
  });

  it('deletes, and reports a missing document as 404', async () => {
    await handleControl(fakeRequest('/kv/workspaces/gone', 'PUT', '{}'), fakeResponse(), opts);
    const del = fakeResponse();
    await handleControl(fakeRequest('/kv/workspaces/gone', 'DELETE'), del, opts);
    expect((await del.done).status).toBe(204);

    const get = fakeResponse();
    await handleControl(fakeRequest('/kv/workspaces/gone'), get, opts);
    expect((await get.done).status).toBe(404);
  });

  it('refuses a traversal attempt in the name', async () => {
    // The key builds a filename, so `..` must be unrepresentable rather than
    // filtered. The charset admits no separator and no dot at all, so these
    // are rejected before any path is constructed.
    for (const bad of ['/kv/workspaces/..', '/kv/ns/a.b', '/kv/ns/a%2Fb', '/kv/ns/a b']) {
      const res = fakeResponse();
      await handleControl(fakeRequest(bad, 'GET'), res, opts);
      const { status } = await res.done;
      expect([400, 404], bad).toContain(status);
    }
  });

  it('never lets a traversal reach the KV handler at all', async () => {
    // Two guards in series, and the first is the URL parser: `/kv/../etc/passwd`
    // NORMALISES to `/etc/passwd` before any of our code sees it, so it is not
    // a KV path and falls through to the RPC adapter. The charset check is the
    // second guard, for anything normalisation leaves intact.
    for (const escaped of ['/kv/../etc/passwd', '/kv/../ns/key']) {
      const handled = await handleControl(fakeRequest(escaped, 'GET'), fakeResponse(), opts);
      expect(handled, escaped).toBe(false);
    }
  });

  it('refuses a body that is not JSON', async () => {
    const res = fakeResponse();
    await handleControl(fakeRequest('/kv/workspaces/bad', 'PUT', 'not json'), res, opts);
    // Storing it would turn every later read into a parse error far from the
    // write that caused it.
    expect((await res.done).status).toBe(400);
  });

  it('refuses an oversized document', async () => {
    const huge = JSON.stringify({ blob: 'x'.repeat(300 * 1024) });
    const res = fakeResponse();
    await handleControl(fakeRequest('/kv/workspaces/huge', 'PUT', huge), res, opts);
    expect((await res.done).status).toBe(413);
  });
});
