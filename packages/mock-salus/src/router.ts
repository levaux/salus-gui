/**
 * router — the Connect handlers, over the fleet model.
 *
 * Split from the server so the whole surface is testable by calling the
 * handler functions directly, with no socket, no port and no timing. The
 * server file then only wires these into an adapter.
 *
 * **The mock's world follows the request.** Every handler here reads what was
 * actually asked — the target service, the resume sequence, the include-closed
 * flag — and answers accordingly. A double that ignores its request looks
 * plausible offline and disagrees with the real fleet in the way that is
 * hardest to diagnose: an empty panel, or one showing something real but not
 * what was asked for.
 */
import { ConnectError, Code } from '@connectrpc/connect';
import { ADMIN_TARGET_HEADER } from './headers.js';
import { LogLevelValue, MockFleet, ServiceStatusValue, type MockLogLine } from './fleet.js';

/** A plain view of the request context the handlers need. */
export interface Ctx {
  header: Headers;
  signal?: AbortSignal;
}

/** Seconds since the fleet's start, for `uptime`-shaped fields. */
function secondsOf(ms: number): bigint {
  return BigInt(Math.floor(ms / 1000));
}

function timestamp(seconds: bigint): { seconds: bigint; nanos: number } {
  return { seconds, nanos: 0 };
}

/**
 * Which Component an Admin call is aimed at.
 *
 * Admin is auto-registered on *every* Component, so the target is carried by
 * the `salus-admin-target` header rather than by the address dialled. An
 * absent header means Network, which is the one every console session already
 * has a reason to talk to.
 */
export function adminTarget(ctx: Ctx): string {
  return ctx.header.get(ADMIN_TARGET_HEADER)?.trim() || 'Network';
}

/** Parse a `salus-*-since-seq` header. Absent, blank or malformed → from the start. */
export function sinceSeq(ctx: Ctx, header: string): bigint {
  const raw = ctx.header.get(header);
  if (raw === null || raw.trim() === '') return 0n;
  try {
    const v = BigInt(raw.trim());
    return v < 0n ? 0n : v;
  } catch {
    // A malformed resume point must not be read as "replay everything from
    // seq 0" silently — but it must also not kill the stream, since the client
    // can recover by resuming again. Start from the beginning and let the
    // client's own dedup handle it.
    return 0n;
  }
}

export interface MockRouterOptions {
  fleet: MockFleet;
  /** Advances on each metrics read so a live panel shows movement. */
  tick?: () => number;
  /**
   * The service this router *is*, when it fronts a dedicated listener.
   *
   * This is the fidelity that matters: on a real fleet, `Admin` is auto-
   * registered on every Component and each one answers **only for itself** —
   * you reach a specific service by dialling its address, not by asking one
   * service about another. The bridge works that way (it resolves
   * `salus-admin-target` to an address and dials it), and it *strips* the
   * header before forwarding, because upstream the header means nothing.
   *
   * So a bound router ignores the header entirely. The header path below
   * survives only for the single-listener mode the unit tests use, where there
   * is no port to distinguish services.
   */
  boundService?: string;
}

export class MockRouter {
  readonly fleet: MockFleet;
  readonly boundService: string | undefined;
  private tickCount = 0;
  private readonly tickFn: () => number;

  constructor(opts: MockRouterOptions) {
    this.fleet = opts.fleet;
    this.tickFn = opts.tick ?? ((): number => this.tickCount++);
    this.boundService = opts.boundService;
  }

  /** Which service an Admin call answers for. */
  private target(ctx: Ctx): string {
    return this.boundService ?? adminTarget(ctx);
  }

  // --- Salus.Admin.Admin ---------------------------------------------------

  ping(): { uptimeSeconds: number } {
    return { uptimeSeconds: 42 };
  }

  getStatus(ctx: Ctx): {
    serviceName: string;
    status: number;
    startedAt: { seconds: bigint; nanos: number };
    uptimeSeconds: bigint;
    listenAddress: string;
    listenPort: number;
  } {
    const name = this.target(ctx);
    const svc = this.fleet.getService(name);
    if (!svc) {
      // A target that does not exist is NOT_FOUND, not a fabricated healthy
      // row. A mock that invents a service teaches the console that every
      // target is reachable.
      throw new ConnectError(`no such service: ${name}`, Code.NotFound);
    }
    return {
      serviceName: svc.name,
      status: svc.status,
      startedAt: timestamp(secondsOf(this.fleet.startedAtMs) - BigInt(svc.uptimeSeconds)),
      uptimeSeconds: BigInt(svc.uptimeSeconds),
      listenAddress: '127.0.0.1',
      listenPort: svc.port,
    };
  }

  getMetrics(ctx: Ctx): {
    threadPoolSize: number;
    activeChannels: number;
    rpcCount: bigint;
    rpcActive: number;
    queueDepth: number;
  } {
    const name = this.target(ctx);
    if (!this.fleet.getService(name)) {
      throw new ConnectError(`no such service: ${name}`, Code.NotFound);
    }
    return this.fleet.metricsFor(name, this.tickFn());
  }

  drain(ctx: Ctx): { accepted: boolean; inFlightRpcs: number; detail: string } {
    const name = this.target(ctx);
    const ok = this.fleet.drain(name);
    if (!ok) throw new ConnectError(`no such service: ${name}`, Code.NotFound);
    // `in_flight_rpcs` is what the service still had to finish when it accepted
    // the drain — reporting a plausible non-zero count keeps the panel that
    // renders it exercised offline.
    return {
      accepted: true,
      inFlightRpcs: this.fleet.metricsFor(name, this.tickFn()).rpcActive,
      detail: `${name} draining`,
    };
  }

  /** One service's own log ring, resumed from `salus-log-since-seq`. */
  adminLogs(ctx: Ctx, header: string): MockLogLine[] {
    const name = this.target(ctx);
    if (!this.fleet.getService(name)) {
      throw new ConnectError(`no such service: ${name}`, Code.NotFound);
    }
    return this.fleet.logsFor(name, sinceSeq(ctx, header));
  }

  // --- Salus.Network.Network ----------------------------------------------

  getRegistryStatus(): {
    registered: number;
    entries: {
      serviceName: string;
      adminAddress: string;
      status: number;
      connected: boolean;
      failCount: number;
      lastSeen: { seconds: bigint; nanos: number };
      authenticatedSubject: string;
    }[];
  } {
    const services = this.fleet.listServices();
    return {
      registered: services.length,
      entries: services.map((s) => ({
        serviceName: s.name,
        adminAddress: `127.0.0.1:${s.port}`,
        status: s.status,
        connected: s.connected,
        failCount: s.failCount,
        lastSeen: timestamp(secondsOf(this.fleet.startedAtMs)),
        // The private plane registers without passing the JWT-enforcing edge,
        // and the platform records that as this exact literal rather than an
        // empty string.
        authenticatedSubject: '(unauthenticated)',
      })),
    };
  }

  getAllStatus(): {
    entries: {
      serviceName: string;
      adminAddress: string;
      status: {
        serviceName: string;
        status: number;
        startedAt: { seconds: bigint; nanos: number };
        uptimeSeconds: bigint;
        listenAddress: string;
        listenPort: number;
      };
    }[];
  } {
    return {
      entries: this.fleet.listServices().map((s) => ({
        serviceName: s.name,
        adminAddress: `127.0.0.1:${s.port}`,
        status: {
          serviceName: s.name,
          status: s.status,
          startedAt: timestamp(secondsOf(this.fleet.startedAtMs) - BigInt(s.uptimeSeconds)),
          uptimeSeconds: BigInt(s.uptimeSeconds),
          listenAddress: '127.0.0.1',
          listenPort: s.port,
        },
      })),
    };
  }

  getAllMetrics(): {
    entries: {
      serviceName: string;
      adminAddress: string;
      metrics: {
        threadPoolSize: number;
        activeChannels: number;
        rpcCount: bigint;
        rpcActive: number;
        queueDepth: number;
      };
    }[];
  } {
    const tick = this.tickFn();
    return {
      entries: this.fleet.listServices().map((s) => ({
        serviceName: s.name,
        adminAddress: `127.0.0.1:${s.port}`,
        metrics: this.fleet.metricsFor(s.name, tick),
      })),
    };
  }

  /** The aggregate ring, resumed from `salus-log-since-seq`. */
  networkLogs(ctx: Ctx, header: string): MockLogLine[] {
    return this.fleet.aggregateLogsSince(sinceSeq(ctx, header));
  }

  /**
   * Lifecycle events, derived from the fleet rather than invented: one
   * "started" per service, plus an "error" for anything degraded. Resumed from
   * `salus-lifecycle-since-seq`.
   */
  lifecycleEvents(
    ctx: Ctx,
    header: string,
  ): {
    timestamp: { seconds: bigint; nanos: number };
    serviceName: string;
    eventType: string;
    message: string;
    status: number;
    seq: bigint;
  }[] {
    const since = sinceSeq(ctx, header);
    const events: {
      timestamp: { seconds: bigint; nanos: number };
      serviceName: string;
      eventType: string;
      message: string;
      status: number;
      seq: bigint;
    }[] = [];
    let seq = 0n;
    for (const s of this.fleet.listServices()) {
      seq += 1n;
      events.push({
        timestamp: timestamp(secondsOf(this.fleet.startedAtMs) - BigInt(s.uptimeSeconds)),
        serviceName: s.name,
        eventType: 'started',
        message: `${s.name} registered`,
        status: s.status,
        seq,
      });
      if (s.status === ServiceStatusValue.DEGRADED) {
        seq += 1n;
        events.push({
          timestamp: timestamp(secondsOf(this.fleet.startedAtMs)),
          serviceName: s.name,
          eventType: 'error',
          message: `${s.name} heartbeat failing (${s.failCount})`,
          status: s.status,
          seq,
        });
      }
    }
    return events.filter((e) => e.seq > since);
  }

  // --- Salus.Session.Session ----------------------------------------------

  listSessions(req: { includeClosed?: boolean }): {
    sessions: {
      subject: string;
      jti: string;
      connectedAt: bigint;
      expiresAt: bigint;
      lastHeard: bigint;
      requestCount: bigint;
      revoked: boolean;
      revokedAt: bigint;
      scopes: string[];
      status: number;
    }[];
  } {
    const sessions = this.fleet.listSessions(req.includeClosed === true);
    return {
      sessions: sessions.map((s) => ({
        subject: s.subject,
        jti: s.jti,
        connectedAt: s.connectedAt,
        expiresAt: s.expiresAt,
        lastHeard: s.lastHeard,
        requestCount: s.requestCount,
        revoked: s.revoked,
        revokedAt: s.revokedAt,
        scopes: [...s.scopes],
        // The platform's own mapping: RUNNING active, ERROR ejected,
        // STOPPED expired. An ejected session is not merely "stopped" — an
        // operator did that on purpose and the roster should say so.
        status: s.revoked ? ServiceStatusValue.ERROR : ServiceStatusValue.RUNNING,
      })),
    };
  }

  ejectSession(req: { subject?: string; jti?: string; reason?: string }): {
    ejected: boolean;
    sessionsRevoked: number;
    message: string;
  } {
    if (!req.subject && !req.jti) {
      throw new ConnectError('eject requires a subject or a jti', Code.InvalidArgument);
    }
    const target: { subject?: string; jti?: string } = {};
    if (req.subject !== undefined) target.subject = req.subject;
    if (req.jti !== undefined) target.jti = req.jti;
    const revoked = this.fleet.eject(target, secondsOf(this.fleet.startedAtMs));
    return {
      ejected: revoked > 0,
      sessionsRevoked: revoked,
      message:
        revoked > 0
          ? `revoked ${revoked} session(s): ${req.reason ?? 'no reason given'}`
          : 'no live session matched',
    };
  }
}

export { LogLevelValue, ServiceStatusValue };
