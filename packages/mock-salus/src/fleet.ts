/**
 * fleet — the mock's model of a running Salus deployment.
 *
 * One in-memory fleet, derived from the seed, holding exactly what the console
 * reads: which services are registered, their Admin status and metrics, their
 * log lines, and the session roster. Everything is a pure function of
 * `(seed, service, tick)` except the handful of things an operator *changes* —
 * ejecting a session, draining a service — which mutate this model so the
 * change is observable on the next read. That is the point: a mock where a
 * mutating call returns OK and changes nothing lets a panel look correct while
 * proving nothing.
 *
 * Ports mirror the real deployment (`docs/service-ports.md` in the platform
 * repo). The hub rebases them onto one listener; the model keeps the true ones
 * so what the console displays matches what an operator would see live.
 */
import { intBetween, pick, unit, wave } from './deterministic.js';

/** `Salus.Common.ServiceStatus` numeric values. */
export const ServiceStatusValue = {
  UNKNOWN: 0,
  STARTING: 1,
  RUNNING: 2,
  DEGRADED: 3,
  STOPPED: 4,
  ERROR: 5,
} as const;

/** `Salus.Admin.LogLevel` numeric values. */
export const LogLevelValue = {
  UNSPECIFIED: 0,
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ALARM: 5,
  ERROR: 6,
  FATAL: 7,
  TEST: 8,
} as const;

export interface MockService {
  readonly name: string;
  readonly port: number;
  status: number;
  /** Seconds since this service started, at fleet construction. */
  readonly uptimeSeconds: number;
  readonly threadPoolSize: number;
  connected: boolean;
  failCount: number;
  /** Set when an operator drains it, so the change is visible on re-read. */
  drained: boolean;
  /** `Admin.SetTrace` / `Admin.SetDebug` — flags an operator toggles and reads back. */
  trace: boolean;
  debug: boolean;
  /** Set by `Admin.Shutdown`; the service stops answering as RUNNING. */
  stopped: boolean;
}

export interface MockSession {
  readonly subject: string;
  readonly jti: string;
  readonly connectedAt: bigint;
  readonly expiresAt: bigint;
  lastHeard: bigint;
  readonly requestCount: bigint;
  readonly scopes: string[];
  revoked: boolean;
  revokedAt: bigint;
}

export interface MockLogLine {
  readonly seq: bigint;
  readonly timestampUs: bigint;
  readonly level: number;
  readonly label: string;
  readonly message: string;
  /** Which service emitted it — the aggregate view needs the attribution. */
  readonly service: string;
}

/**
 * The real fleet's shape: the six services plus the ports they listen on.
 * `Edge` is absent deliberately — an Edge is a *client*, and it appears in the
 * registry only when one is running with `--register`, which is not the
 * default.
 */
const SERVICES: readonly { name: string; port: number }[] = [
  { name: 'Network', port: 57000 },
  { name: 'Authentication', port: 57010 },
  { name: 'Session', port: 57020 },
  { name: 'Health', port: 57030 },
  { name: 'Therapy', port: 57040 },
  { name: 'Protocol', port: 57050 },
];

const LOG_LABELS = ['Component', 'AdminService', 'CallData', 'ThreadPool', 'NetworkRegistry'];

const LOG_TEMPLATES: readonly { level: number; text: string }[] = [
  { level: LogLevelValue.INFO, text: 'Component started' },
  { level: LogLevelValue.INFO, text: 'Registered with Network' },
  { level: LogLevelValue.DEBUG, text: 'Heartbeat ping ok' },
  { level: LogLevelValue.DEBUG, text: 'CallData recycled' },
  { level: LogLevelValue.INFO, text: 'Subscriber attached' },
  { level: LogLevelValue.TRACE, text: 'Thread pool idle' },
  { level: LogLevelValue.WARN, text: 'Heartbeat latency above budget' },
  { level: LogLevelValue.ALARM, text: 'Stream admission ceiling approached' },
  { level: LogLevelValue.ERROR, text: 'Upstream call failed: UNAVAILABLE' },
];

export interface FleetOptions {
  seed?: string;
  /** How many log lines to pre-seed per service. */
  logDepth?: number;
  /** Wall-clock ms the fleet pretends to have started from. */
  startedAtMs?: number;
}

export class MockFleet {
  readonly seed: string;
  readonly startedAtMs: number;
  private readonly services = new Map<string, MockService>();
  private readonly sessions = new Map<string, MockSession>();
  /** Per-service log rings, and the aggregate Network sees. */
  private readonly logsByService = new Map<string, MockLogLine[]>();
  private readonly aggregateLogs: MockLogLine[] = [];
  private aggregateSeq = 0n;

  constructor(opts: FleetOptions = {}) {
    this.seed = opts.seed ?? 'salus-mock';
    this.startedAtMs = opts.startedAtMs ?? Date.UTC(2026, 8, 8, 0, 0, 0);
    const depth = opts.logDepth ?? 40;

    for (const { name, port } of SERVICES) {
      // Deterministic, and deliberately not all-green: a console that has only
      // ever been seen against a healthy fleet has never shown its operator
      // what trouble looks like.
      const roll = unit(this.seed, name, 'status');
      const status =
        roll > 0.92
          ? ServiceStatusValue.DEGRADED
          : roll > 0.88
            ? ServiceStatusValue.STARTING
            : ServiceStatusValue.RUNNING;
      this.services.set(name, {
        name,
        port,
        status,
        uptimeSeconds: intBetween(120, 86_400, this.seed, name, 'uptime'),
        threadPoolSize: intBetween(2, 8, this.seed, name, 'threads'),
        connected: status !== ServiceStatusValue.STARTING,
        failCount: status === ServiceStatusValue.DEGRADED ? intBetween(1, 3, this.seed, name) : 0,
        drained: false,
        trace: false,
        debug: false,
        stopped: false,
      });
      this.logsByService.set(name, []);
    }

    for (let i = 0; i < depth; i++) {
      for (const { name } of SERVICES) this.appendLog(name, i);
    }

    for (let i = 0; i < 4; i++) this.seedSession(i);
  }

  // --- services ------------------------------------------------------------

  listServices(): MockService[] {
    return [...this.services.values()];
  }

  getService(name: string): MockService | undefined {
    return this.services.get(name);
  }

  /** Metrics vary with `tick` so a live panel shows movement, reproducibly. */
  metricsFor(
    name: string,
    tick: number,
  ): {
    threadPoolSize: number;
    activeChannels: number;
    rpcCount: bigint;
    rpcActive: number;
    queueDepth: number;
  } {
    const svc = this.services.get(name);
    const pool = svc?.threadPoolSize ?? 4;
    return {
      threadPoolSize: pool,
      activeChannels: Math.round(wave(tick, 1, 12, this.seed, name, 'channels')),
      rpcCount: BigInt(intBetween(1_000, 500_000, this.seed, name, 'rpcs') + tick * 7),
      rpcActive: Math.round(wave(tick, 0, 6, this.seed, name, 'active')),
      queueDepth: Math.round(wave(tick, 0, pool, this.seed, name, 'queue')),
    };
  }

  /** Drain a service — an operator action, so it must change what reads return. */
  drain(name: string): boolean {
    const svc = this.services.get(name);
    if (!svc) return false;
    svc.drained = true;
    svc.status = ServiceStatusValue.DEGRADED;
    return true;
  }

  /**
   * Stop a service. STOPPED rather than ERROR: an operator's deliberate
   * shutdown is a different condition from a service that failed, and the
   * console colours them differently on purpose.
   */
  shutdown(name: string): boolean {
    const svc = this.services.get(name);
    if (!svc) return false;
    svc.stopped = true;
    svc.connected = false;
    svc.status = ServiceStatusValue.STOPPED;
    return true;
  }

  /**
   * Toggle a log flag and report the resulting state.
   *
   * `SetLogLevelResponse` carries **only `enabled`** — there is no `previous`
   * field in the proto, so a caller cannot render "trace on (was off)" from
   * one call, and must not pretend to. The flag is kept here so a subsequent
   * `GetConfig` reflects it, which is the honest way to read it back.
   */
  setLogFlag(name: string, flag: 'trace' | 'debug', enabled: boolean): { enabled: boolean } {
    const svc = this.services.get(name);
    if (!svc) throw new RangeError(`no such service: ${name}`);
    svc[flag] = enabled;
    return { enabled };
  }

  /**
   * A service's config as `Admin.GetConfig` returns it: `{ format, payload }`,
   * a serialized blob rather than a field list, so the console parses `payload`
   * according to `format` instead of reading typed entries.
   *
   * `redactSecrets` is **honoured, not assumed**. The console always asks for
   * redaction, but a mock that redacted regardless would hide a console that
   * forgot to ask — the request field would be dead and nobody would know.
   */
  configFor(name: string, redactSecrets: boolean): { format: string; payload: string } {
    const svc = this.services.get(name);
    if (!svc) throw new RangeError(`no such service: ${name}`);
    const secret = redactSecrets ? '<redacted>' : 'dev-value-not-a-real-secret';
    return {
      format: 'json',
      payload: JSON.stringify(
        {
          service_name: svc.name,
          listen_port: svc.port,
          thread_pool_size: svc.threadPoolSize,
          network_address: '127.0.0.1:57000',
          trace_enabled: svc.trace,
          debug_enabled: svc.debug,
          auth_secret: secret,
          records_dsn: secret,
        },
        null,
        2,
      ),
    };
  }

  // --- logs ----------------------------------------------------------------

  private appendLog(service: string, i: number): void {
    const tpl = pick(LOG_TEMPLATES, this.seed, service, 'tpl', i);
    const label = pick(LOG_LABELS, this.seed, service, 'label', i);
    const ring = this.logsByService.get(service)!;
    const perServiceSeq = BigInt(ring.length + 1);
    // 250 ms apart, so a window query has something meaningful to slice.
    const timestampUs = BigInt((this.startedAtMs + i * 250) * 1000);

    const line: MockLogLine = {
      seq: perServiceSeq,
      timestampUs,
      level: tpl.level,
      label: `${service}|${label}`,
      message: tpl.text,
      service,
    };
    ring.push(line);

    this.aggregateSeq += 1n;
    this.aggregateLogs.push({ ...line, seq: this.aggregateSeq });
  }

  /**
   * A service's own log ring, resumed. `sinceSeq` is exclusive, matching the
   * platform's documented `salus-log-since-seq` contract: the producer replays
   * only `seq > since`, so a reconnect yields no duplicate and no gap.
   */
  logsFor(service: string, sinceSeq = 0n): MockLogLine[] {
    return (this.logsByService.get(service) ?? []).filter((l) => l.seq > sinceSeq);
  }

  /** Network's aggregate ring, resumed the same way. */
  aggregateLogsSince(sinceSeq = 0n): MockLogLine[] {
    return this.aggregateLogs.filter((l) => l.seq > sinceSeq);
  }

  /** Append one new line to a service — how a live stream keeps producing. */
  emitLog(service: string): MockLogLine | undefined {
    if (!this.logsByService.has(service)) return undefined;
    const ring = this.logsByService.get(service)!;
    this.appendLog(service, ring.length);
    return this.aggregateLogs[this.aggregateLogs.length - 1];
  }

  // --- sessions ------------------------------------------------------------

  private seedSession(i: number): void {
    const subject = `edge-client-${String(i + 1).padStart(3, '0')}`;
    const jti = `jti-${this.seed}-${i}`;
    const connectedAt = BigInt(
      Math.floor(this.startedAtMs / 1000) - intBetween(60, 7200, this.seed, subject),
    );
    this.sessions.set(jti, {
      subject,
      jti,
      connectedAt,
      expiresAt: connectedAt + 3600n,
      lastHeard: connectedAt + BigInt(intBetween(1, 600, this.seed, subject, 'heard')),
      requestCount: BigInt(intBetween(5, 4000, this.seed, subject, 'reqs')),
      scopes: ['register', 'invoke'],
      revoked: false,
      revokedAt: 0n,
    });
  }

  /**
   * `includeClosed` is honoured, not ignored. A mock that returns revoked
   * sessions to a caller asking only for open ones makes the offline stack
   * disagree with the fleet in exactly the way that is hardest to notice.
   */
  listSessions(includeClosed: boolean): MockSession[] {
    const all = [...this.sessions.values()];
    return includeClosed ? all : all.filter((s) => !s.revoked);
  }

  getSession(jti: string): MockSession | undefined {
    return this.sessions.get(jti);
  }

  /**
   * Eject by subject (every session for that client) or by jti (one token).
   * Returns how many were actually revoked — re-ejecting an already-revoked
   * session revokes nothing, which is what an idempotent operator action
   * should report.
   */
  eject(target: { subject?: string; jti?: string }, atSeconds: bigint): number {
    let revoked = 0;
    for (const s of this.sessions.values()) {
      const matches =
        (target.jti !== undefined && s.jti === target.jti) ||
        (target.subject !== undefined && s.subject === target.subject);
      if (!matches || s.revoked) continue;
      s.revoked = true;
      s.revokedAt = atSeconds;
      revoked++;
    }
    return revoked;
  }
}
