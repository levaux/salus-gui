import { describe, expect, it } from 'vitest';
import { ConnectError, Code } from '@connectrpc/connect';
import { MockFleet, ServiceStatusValue } from './fleet.js';
import { MockRouter, adminTarget, sinceSeq, type Ctx } from './router.js';
import {
  ADMIN_TARGET_HEADER,
  LIFECYCLE_SINCE_SEQ_HEADER,
  LOG_SINCE_SEQ_HEADER,
} from './headers.js';

const ctx = (headers: Record<string, string> = {}): Ctx => ({ header: new Headers(headers) });

const router = (): MockRouter => new MockRouter({ fleet: new MockFleet({ seed: 'test' }) });

describe("the metadata keys are the platform's own", () => {
  it('matches the strings the vendored protos document', () => {
    // These appear verbatim in Salus.Admin.LogEntry.seq and
    // Salus.Network.LifecycleEvent.seq field comments. A rename on either side
    // silently breaks resume, so pin the literals.
    expect(LOG_SINCE_SEQ_HEADER).toBe('salus-log-since-seq');
    expect(LIFECYCLE_SINCE_SEQ_HEADER).toBe('salus-lifecycle-since-seq');
    expect(ADMIN_TARGET_HEADER).toBe('salus-admin-target');
  });
});

describe('the mock answers the request it was given', () => {
  it('Admin targets the service the header names', () => {
    const r = router();
    expect(r.getStatus(ctx({ [ADMIN_TARGET_HEADER]: 'Therapy' })).serviceName).toBe('Therapy');
    expect(r.getStatus(ctx({ [ADMIN_TARGET_HEADER]: 'Protocol' })).serviceName).toBe('Protocol');
    // Admin exists on every Component, so answering one fixed service would
    // make every drawer in the console show the same process.
    expect(r.getStatus(ctx({ [ADMIN_TARGET_HEADER]: 'Session' })).listenPort).toBe(57020);
  });

  it('defaults to Network when no target is given', () => {
    expect(adminTarget(ctx())).toBe('Network');
    expect(adminTarget(ctx({ [ADMIN_TARGET_HEADER]: '  ' }))).toBe('Network');
    expect(router().getStatus(ctx()).serviceName).toBe('Network');
  });

  it('refuses an unknown target instead of inventing a healthy one', () => {
    // A fabricated row would teach the console that every target is reachable.
    expect(() => router().getStatus(ctx({ [ADMIN_TARGET_HEADER]: 'Nope' }))).toThrow(ConnectError);
    try {
      router().getMetrics(ctx({ [ADMIN_TARGET_HEADER]: 'Nope' }));
    } catch (e) {
      expect((e as ConnectError).code).toBe(Code.NotFound);
    }
  });

  it("Admin logs return only that service's lines", () => {
    const r = router();
    const lines = r.adminLogs(ctx({ [ADMIN_TARGET_HEADER]: 'Health' }), LOG_SINCE_SEQ_HEADER);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.service === 'Health')).toBe(true);
  });

  it('ListSessions honours include_closed', () => {
    const r = router();
    const open = r.listSessions({ includeClosed: false }).sessions;
    r.ejectSession({ jti: open[0]!.jti, reason: 'test' });

    const stillOpen = r.listSessions({ includeClosed: false }).sessions;
    const withClosed = r.listSessions({ includeClosed: true }).sessions;

    // Ignoring the flag would return the revoked row to a caller that asked
    // only for live ones — a disagreement with the real fleet that shows up as
    // a session the operator thinks they failed to eject.
    expect(stillOpen).toHaveLength(open.length - 1);
    expect(withClosed).toHaveLength(open.length);
  });
});

describe('seq resume', () => {
  it('replays strictly newer frames, so no duplicate and no gap', () => {
    const r = router();
    const all = r.networkLogs(ctx(), LOG_SINCE_SEQ_HEADER);
    expect(all.length).toBeGreaterThan(5);

    const fifth = all[4]!.seq;
    const resumed = r.networkLogs(
      ctx({ [LOG_SINCE_SEQ_HEADER]: fifth.toString() }),
      LOG_SINCE_SEQ_HEADER,
    );

    // `since` is exclusive: the client already has `fifth`.
    expect(resumed[0]!.seq).toBe(fifth + 1n);
    expect(resumed).toHaveLength(all.length - 5);
    expect(resumed.some((l) => l.seq <= fifth)).toBe(false);
  });

  it('resumes the lifecycle stream on its own key', () => {
    const r = router();
    const all = r.lifecycleEvents(ctx(), LIFECYCLE_SINCE_SEQ_HEADER);
    expect(all.length).toBeGreaterThan(0);

    const resumed = r.lifecycleEvents(
      ctx({ [LIFECYCLE_SINCE_SEQ_HEADER]: '2' }),
      LIFECYCLE_SINCE_SEQ_HEADER,
    );
    expect(resumed.every((e) => e.seq > 2n)).toBe(true);
  });

  it('treats a missing, blank, negative or malformed resume point as "from the start"', () => {
    expect(sinceSeq(ctx(), LOG_SINCE_SEQ_HEADER)).toBe(0n);
    expect(sinceSeq(ctx({ [LOG_SINCE_SEQ_HEADER]: '' }), LOG_SINCE_SEQ_HEADER)).toBe(0n);
    expect(sinceSeq(ctx({ [LOG_SINCE_SEQ_HEADER]: '-5' }), LOG_SINCE_SEQ_HEADER)).toBe(0n);
    // Malformed must not kill the stream: the client can recover by resuming
    // again, and its own dedup handles the overlap.
    expect(sinceSeq(ctx({ [LOG_SINCE_SEQ_HEADER]: 'not-a-number' }), LOG_SINCE_SEQ_HEADER)).toBe(
      0n,
    );
    expect(sinceSeq(ctx({ [LOG_SINCE_SEQ_HEADER]: ' 12 ' }), LOG_SINCE_SEQ_HEADER)).toBe(12n);
  });
});

describe('mutations are observable on the next read', () => {
  it('ejecting flips the session row and reports what it revoked', () => {
    const r = router();
    const first = r.listSessions({ includeClosed: true }).sessions[0]!;

    const res = r.ejectSession({ jti: first.jti, reason: 'operator test' });
    expect(res.ejected).toBe(true);
    expect(res.sessionsRevoked).toBe(1);

    const after = r
      .listSessions({ includeClosed: true })
      .sessions.find((s) => s.jti === first.jti)!;
    expect(after.revoked).toBe(true);
    // An ejected session is ERROR, not STOPPED: an operator did this on
    // purpose, and the roster should distinguish it from an expiry.
    expect(after.status).toBe(ServiceStatusValue.ERROR);
  });

  it('re-ejecting revokes nothing and says so', () => {
    const r = router();
    const jti = r.listSessions({ includeClosed: true }).sessions[0]!.jti;
    r.ejectSession({ jti });
    const again = r.ejectSession({ jti });
    expect(again.ejected).toBe(false);
    expect(again.sessionsRevoked).toBe(0);
  });

  it('ejects every session for a subject', () => {
    const fleet = new MockFleet({ seed: 'test' });
    const r = new MockRouter({ fleet });
    const subject = r.listSessions({ includeClosed: true }).sessions[0]!.subject;
    const res = r.ejectSession({ subject });
    expect(res.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(
      r.listSessions({ includeClosed: false }).sessions.some((s) => s.subject === subject),
    ).toBe(false);
  });

  it('rejects an eject that names no target', () => {
    expect(() => router().ejectSession({})).toThrow(ConnectError);
  });

  it('draining shows up in the registry', () => {
    const r = router();
    r.drain(ctx({ [ADMIN_TARGET_HEADER]: 'Protocol' }));
    const entry = r.getRegistryStatus().entries.find((e) => e.serviceName === 'Protocol')!;
    expect(entry.status).toBe(ServiceStatusValue.DEGRADED);
  });
});

describe('the fleet it presents', () => {
  it('registers the six services on their real ports', () => {
    const reg = router().getRegistryStatus();
    expect(reg.registered).toBe(6);
    expect(reg.entries.map((e) => e.serviceName)).toEqual([
      'Network',
      'Authentication',
      'Session',
      'Health',
      'Therapy',
      'Protocol',
    ]);
    expect(reg.entries.find((e) => e.serviceName === 'Health')!.adminAddress).toBe(
      '127.0.0.1:57030',
    );
  });

  it('marks private-plane registrations unauthenticated, as the platform does', () => {
    // The literal matters: the platform writes exactly this when registration
    // did not pass the JWT-enforcing edge, and a console column that renders it
    // should be exercised offline too.
    expect(router().getRegistryStatus().entries[0]!.authenticatedSubject).toBe('(unauthenticated)');
  });

  it('reports status for every service through the fan-out', () => {
    const all = router().getAllStatus();
    expect(all.entries).toHaveLength(6);
    expect(all.entries.every((e) => e.status.serviceName === e.serviceName)).toBe(true);
  });

  it('is deterministic: same seed, identical fleet', () => {
    const a = new MockRouter({ fleet: new MockFleet({ seed: 's' }) });
    const b = new MockRouter({ fleet: new MockFleet({ seed: 's' }) });
    expect(JSON.stringify(a.getRegistryStatus(), stringifyBigints)).toBe(
      JSON.stringify(b.getRegistryStatus(), stringifyBigints),
    );
    // Metrics vary with tick but must agree tick-for-tick across instances.
    const ma = new MockRouter({ fleet: new MockFleet({ seed: 's' }), tick: () => 7 });
    const mb = new MockRouter({ fleet: new MockFleet({ seed: 's' }), tick: () => 7 });
    expect(JSON.stringify(ma.getAllMetrics(), stringifyBigints)).toBe(
      JSON.stringify(mb.getAllMetrics(), stringifyBigints),
    );
  });

  it('does not present an all-green fleet', () => {
    // A console only ever seen against a healthy fleet has never shown its
    // operator what trouble looks like.
    const statuses = new Set(
      new MockFleet({ seed: 'salus-mock' }).listServices().map((s) => s.status),
    );
    expect(statuses.size).toBeGreaterThan(1);
  });
});

function stringifyBigints(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
