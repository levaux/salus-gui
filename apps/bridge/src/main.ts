/**
 * main — `salus-bridged`, the browser's only counterparty.
 *
 * A `node:http2` secure server on :56400 that answers three things:
 *
 *   /rpc/*     Connect ⇄ gRPC forward to the Salus fleet
 *   /kv/*      bridge-local document store
 *   /bridge/*  bridge-local control (info, audit, read-only switch)
 *
 * `SETTINGS_MAX_CONCURRENT_STREAMS` is raised well above the default because
 * the whole reason this process exists is stream multiplexing: a workspace can
 * hold twenty-plus live feeds, and the default ceiling would queue them
 * invisibly.
 */
import { createSecureServer } from 'node:http2';
import type { Http2SecureServer } from 'node:http2';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { ConnectRouter } from '@connectrpc/connect';
import { SERVICE_CATALOG, serviceById } from '@salus-gui/proto/services';

import { AuditLog } from './audit.js';
import { loadTls } from './certs.js';
import { handleControl } from './control.js';
import { forwardService } from './forward.js';
import { ADMIN_TARGET_HEADER } from './headers.js';
import { KvStore } from './kv.js';
import { SiteContext, loadSites, type Site } from './services.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');

export const BRIDGE_PORT = 56400;

/** Loopback origins the dev SPA is served from. */
const DEV_ORIGINS = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];

function corsOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const extra = process.env.BRIDGE_CORS_ORIGIN;
  if (extra && origin === extra) return origin;
  return DEV_ORIGINS.some((re) => re.test(origin)) ? origin : undefined;
}

export interface BridgeOptions {
  port?: number;
  site: SiteContext;
  audit: AuditLog;
  kv: KvStore;
  tls: { key: Buffer; cert: Buffer };
}

/** Build the Connect router: one forward per catalog entry. */
export function buildRoutes(site: SiteContext, audit: AuditLog) {
  return (router: ConnectRouter): void => {
    for (const entry of SERVICE_CATALOG) {
      const transport = site.transports.get(entry.id);
      if (!transport) continue;

      // Admin is on every Component, so its target comes per call from the
      // header rather than from the catalog's default port.
      const dynamicTransport =
        entry.dynamicTarget === true
          ? (header: Headers): ReturnType<SiteContext['adminTransportFor']> | undefined => {
              const target = header.get(ADMIN_TARGET_HEADER);
              return target ? site.adminTransportFor(target) : undefined;
            }
          : undefined;

      forwardService(
        router,
        { id: entry.id, service: entry.service as Parameters<typeof forwardService>[1]['service'] },
        transport,
        dynamicTransport ? { site, audit, dynamicTransport } : { site, audit },
      );
    }
  };
}

export function createBridge(opts: BridgeOptions): Http2SecureServer {
  const adapter = connectNodeAdapter({
    routes: buildRoutes(opts.site, opts.audit),
    requestPathPrefix: '/rpc',
  });

  const server = createSecureServer(
    {
      key: opts.tls.key,
      cert: opts.tls.cert,
      allowHTTP1: true, // a dev proxy may still reach us over HTTP/1.1
      settings: { maxConcurrentStreams: 256 },
    },
    (req, res) => {
      const origin = corsOrigin(req.headers.origin);
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('vary', 'origin');
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
        // Connect and gRPC-Web negotiate through headers the browser must be
        // allowed to send, and our own resume/target keys ride alongside them.
        res.setHeader(
          'access-control-allow-headers',
          [
            'content-type',
            'connect-protocol-version',
            'connect-timeout-ms',
            'x-user-agent',
            'x-grpc-web',
            'grpc-timeout',
            'authorization',
            'salus-admin-target',
            'salus-log-since-seq',
            'salus-lifecycle-since-seq',
          ].join(', '),
        );
        res.setHeader('access-control-max-age', '86400');
        res.writeHead(204);
        res.end();
        return;
      }

      void handleControl(req, res, { site: opts.site, audit: opts.audit, kv: opts.kv })
        .then((handled) => {
          if (!handled) adapter(req, res);
        })
        .catch((err: unknown) => {
          console.error('bridge: control handler failed:', err);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
    },
  );

  return server;
}

export function pickSite(sites: Site[], id: string | undefined): Site {
  if (id === undefined) return sites[0]!;
  const found = sites.find((s) => s.id === id);
  if (!found) {
    throw new Error(`no site '${id}' in sites.json (have: ${sites.map((s) => s.id).join(', ')})`);
  }
  return found;
}

async function run(): Promise<void> {
  const port = Number(process.env.BRIDGE_PORT ?? BRIDGE_PORT);
  const sites = loadSites(join(APP_ROOT, 'sites.json'));
  const site = new SiteContext(pickSite(sites, process.env.BRIDGE_SITE));
  const audit = new AuditLog({ dir: join(APP_ROOT, 'audit') });
  const kv = new KvStore(join(APP_ROOT, 'kv'));
  const tls = loadTls(join(APP_ROOT, 'certs'));

  const server = createBridge({ port, site, audit, kv, tls });
  server.listen(port, () => {
    console.log(`salus-bridged listening on https://localhost:${port}`);
    console.log(
      `  site "${site.site.id}" (${site.site.env}) → ${site.site.services.host}` +
        `${site.site.services.portBase !== undefined ? ` rebased to :${site.site.services.portBase}` : ''}` +
        `${site.readOnly ? ' [READ-ONLY]' : ''}`,
    );
    console.log(`  services: ${SERVICE_CATALOG.map((s) => s.id).join(', ')}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void audit.flush().then(() => {
        server.close(() => process.exit(0));
      });
    });
  }
}

// Only run when executed directly — importing this module (tests) must not
// start a listener.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { serviceById };
