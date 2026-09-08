/**
 * control — the bridge's own HTTP surface: `/bridge/*` and `/kv/*`.
 *
 * Kept as a plain request handler rather than Connect routes: these are
 * bridge-local state, not fleet RPCs, and putting them on the RPC path would
 * imply the platform serves them.
 *
 * The read-only switch lives here. One flip refuses every mutating RPC across
 * the whole site — and, from the harness and session stages onward, every
 * bridge-local mutation too. The value of that switch is exactly its breadth,
 * so nothing may quietly opt out of it.
 */
import type { AuditLog } from './audit.js';
import { KvError, type KvStore } from './kv.js';
import type { SiteContext } from './services.js';

/**
 * The request and response shapes this module needs, structurally.
 *
 * The server is HTTP/2 with `allowHTTP1`, so a handler sees either
 * `Http2ServerRequest` or `IncomingMessage` depending on how the client
 * connected. Naming the shape rather than either concrete type keeps this
 * correct for both — and lets the tests drive it with plain fakes instead of a
 * live socket.
 */
export interface ControlRequest extends AsyncIterable<Buffer> {
  url?: string | undefined;
  method?: string | undefined;
}

export interface ControlResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  // Overloads rather than an optional parameter: Node's own `end` is
  // `end(callback?)` / `end(data, callback?)`, and a single `end(chunk?)`
  // signature is not assignable from it.
  end(): unknown;
  end(chunk: string): unknown;
}

export interface ControlOptions {
  site: SiteContext;
  audit: AuditLog;
  kv: KvStore;
}

function sendJson(res: ControlResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

async function readBody(req: ControlRequest, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Stop reading rather than buffering an unbounded body: the limit has to
    // bound memory, not just reject after the fact.
    if (size > limit) throw new KvError(`body exceeds ${limit} bytes`, 413);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Handle a bridge-local request. Returns true when it handled it, false when
 * the path is not ours (so the caller can fall through to the RPC adapter).
 */
export async function handleControl(
  req: ControlRequest,
  res: ControlResponse,
  opts: ControlOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://bridge');
  const path = url.pathname;

  if (path === '/bridge/info') {
    sendJson(res, 200, {
      site: opts.site.site.id,
      name: opts.site.site.name,
      env: opts.site.site.env,
      host: opts.site.site.services.host,
      portBase: opts.site.site.services.portBase ?? null,
      readOnly: opts.site.readOnly,
    });
    return true;
  }

  if (path === '/bridge/audit') {
    const limit = Number(url.searchParams.get('limit') ?? '100');
    sendJson(res, 200, {
      entries: opts.audit.recent(Number.isFinite(limit) ? limit : 100),
    });
    return true;
  }

  if (path === '/bridge/readonly') {
    if (req.method === 'GET') {
      sendJson(res, 200, { readOnly: opts.site.readOnly });
      return true;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readBody(req, 1024);
        const parsed = JSON.parse(body) as { readOnly?: unknown };
        if (typeof parsed.readOnly !== 'boolean') {
          sendJson(res, 400, { error: 'body must be {"readOnly": boolean}' });
          return true;
        }
        opts.site.readOnly = parsed.readOnly;
        // Flipping the switch is itself an operator action worth recording.
        void opts.audit.append({
          ts: Date.now(),
          site: opts.site.site.id,
          service: 'bridge',
          rpc: parsed.readOnly ? 'EnterReadOnly' : 'LeaveReadOnly',
          argsHash: '-',
          outcome: 'ok',
          latencyMs: 0,
          mutating: true,
        });
        sendJson(res, 200, { readOnly: opts.site.readOnly });
      } catch (err) {
        const status = err instanceof KvError ? err.status : 400;
        sendJson(res, status, { error: (err as Error).message });
      }
      return true;
    }
    sendJson(res, 405, { error: 'GET or PUT' });
    return true;
  }

  if (path.startsWith('/kv/')) {
    const [, , ns, key] = path.split('/');
    try {
      if (ns === undefined || ns === '') {
        sendJson(res, 400, { error: 'missing namespace' });
        return true;
      }
      if (key === undefined || key === '') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'GET to list a namespace' });
          return true;
        }
        sendJson(res, 200, { keys: await opts.kv.list(ns) });
        return true;
      }

      switch (req.method) {
        case 'GET': {
          const doc = await opts.kv.get(ns, key);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(doc);
          return true;
        }
        case 'PUT':
        case 'POST': {
          await opts.kv.put(ns, key, await readBody(req, 256 * 1024));
          sendJson(res, 204, {});
          return true;
        }
        case 'DELETE': {
          await opts.kv.delete(ns, key);
          sendJson(res, 204, {});
          return true;
        }
        default:
          sendJson(res, 405, { error: 'GET, PUT or DELETE' });
          return true;
      }
    } catch (err) {
      if (err instanceof KvError) {
        sendJson(res, err.status, { error: err.message });
        return true;
      }
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    }
  }

  return false;
}
