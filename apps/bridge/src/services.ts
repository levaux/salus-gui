/**
 * services — per-site backend resolution.
 *
 * `sites.json` is the registry: each entry names a Salus deployment.
 * `resolveTargets` turns one `Site` into a gRPC transport per `SERVICE_CATALOG`
 * entry, and `SiteContext` bundles those with the per-site read-only flag the
 * forward middleware reads.
 *
 * Two sites ship: `dev-mock` (rebased onto the mock hub) and `dev-local` (a
 * real fleet on its documented ports). Nothing here is single-site specific —
 * later selection by host header sits on the same `SiteContext` shape.
 */
import { readFileSync } from 'node:fs';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { Code, ConnectError, type Transport } from '@connectrpc/connect';

import { CATALOG_PORT_BASE, SERVICE_CATALOG } from '@salus-gui/proto/services';

export interface SiteServiceTarget {
  readonly host: string;
  /**
   * Rebases the whole catalog port range onto a different base — the mock's
   * single hub at :56800 (`port = portBase + (catalogPort - 57000)`). Omit to
   * talk to a real fleet on its documented absolute ports.
   */
  readonly portBase?: number;
}

export interface Site {
  readonly id: string;
  readonly name: string;
  /** Drives the console's environment band. */
  readonly env: 'dev' | 'mock' | 'staging' | 'prod';
  readonly readOnly?: boolean;
  readonly services: SiteServiceTarget;
}

/** Load + parse `sites.json`. Throws if missing, empty, or malformed. */
export function loadSites(path: string): Site[] {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`loadSites: ${path} must contain a non-empty JSON array of sites`);
  }
  return parsed as Site[];
}

export function resolvePort(target: SiteServiceTarget, catalogPort: number): number {
  return target.portBase === undefined
    ? catalogPort
    : target.portBase + (catalogPort - CATALOG_PORT_BASE);
}

/** One backend transport per catalog entry, keyed by `ServiceEntry.id`. */
export function resolveTargets(site: Site): Map<string, Transport> {
  const targets = new Map<string, Transport>();
  for (const entry of SERVICE_CATALOG) {
    const port = resolvePort(site.services, entry.port);
    targets.set(
      entry.id,
      createGrpcTransport({
        // connect-node's gRPC transport is HTTP/2 only and speaks cleartext h2c
        // to an http:// baseUrl — matching the platform's plaintext internal
        // gRPC listeners.
        baseUrl: `http://${site.services.host}:${port}`,
      }),
    );
  }
  return targets;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export interface SiteContextOptions {
  readonly readOnly?: boolean;
}

/** A site's resolved transports plus the read-only flag the forward guard reads. */
export class SiteContext {
  readonly site: Site;
  readonly transports: Map<string, Transport>;
  readOnly: boolean;
  /** Pool of per-Component transports, keyed by "host:port". */
  private readonly adminTransports = new Map<string, Transport>();

  constructor(site: Site, opts: SiteContextOptions = {}) {
    this.site = site;
    this.transports = resolveTargets(site);
    this.readOnly = opts.readOnly ?? site.readOnly ?? false;
  }

  /**
   * A transport to one Component's own address, so the console can reach any
   * process's Admin surface rather than only the catalog defaults — the
   * registry hands out `admin_address`, and an Edge running
   * `--application-control` is reachable the same way.
   *
   * **The address is browser-supplied**, so it is validated as `host:port` and
   * the host is pinned to this site's host or loopback. Without that pin the
   * bridge is an open proxy: anything that can reach the console could dial
   * arbitrary hosts through it.
   *
   * Loopback rewrite: a service registers the address *it* binds, which is
   * loopback relative to the SERVICE host. From a bridge on another machine
   * that loopback is the bridge's own box, where nothing is listening — so a
   * loopback admin host is rewritten to the site host, and the port is rebased
   * exactly as the catalog transports are (a no-op for a real fleet, the
   * matching mock port when rebasing).
   */
  adminTransportFor(address: string): Transport {
    const existing = this.adminTransports.get(address);
    if (existing) return existing;

    const lastColon = address.lastIndexOf(':');
    const host = lastColon > 0 ? address.slice(0, lastColon) : '';
    const port = Number(address.slice(lastColon + 1));
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ConnectError(`invalid admin target '${address}'`, Code.InvalidArgument);
    }
    const allowed = new Set([this.site.services.host, ...LOOPBACK]);
    if (!allowed.has(host)) {
      throw new ConnectError(`admin target host '${host}' not allowed`, Code.PermissionDenied);
    }

    const dialHost = LOOPBACK.has(host) ? this.site.services.host : host;
    const dialPort = resolvePort(this.site.services, port);
    const transport = createGrpcTransport({ baseUrl: `http://${dialHost}:${dialPort}` });
    this.adminTransports.set(address, transport);
    return transport;
  }
}
