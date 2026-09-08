import { describe, expect, it } from 'vitest';
import { MockFleet, ServiceStatusValue } from './fleet.js';
import { MockRouter, type Ctx } from './router.js';
import { MockTelemetry, RpcKindValue, DirectionValue } from './telemetry.js';
import { ADMIN_TARGET_HEADER } from './headers.js';

const ctx = (headers: Record<string, string> = {}): Ctx => ({ header: new Headers(headers) });
const router = (): MockRouter => new MockRouter({ fleet: new MockFleet({ seed: 'test' }) });
const telemetry = (): MockTelemetry =>
  new MockTelemetry({ seed: 'test', startedAtMs: Date.UTC(2026, 8, 8) });

describe('the snapshot has no sequence, because the proto has none', () => {
  it('carries snapshot_at_us, components and rows — and nothing seq-shaped', () => {
    // SuiteSnapshot declares snapshot_at_us + components[] + rows[]; there is
    // no seq field and StreamSuiteSnapshotRequest is empty. A mock that
    // invented one would let the console build a resume path that cannot work
    // against a real Network, and would licence a fabricated number in the
    // footer. See the design reference §7.8.
    const frame = telemetry().snapshot(5);
    expect(Object.keys(frame).sort()).toEqual(['components', 'rows', 'snapshotAtUs']);
    expect('seq' in frame).toBe(false);
    for (const row of frame.rows) expect('seq' in row).toBe(false);
  });

  it('is a complete frame every time, so reconnect just takes the next one', () => {
    const t = telemetry();
    const a = t.snapshot(1);
    const b = t.snapshot(2);
    // Same shape and same component set — a later frame is not a delta.
    expect(b.components.map((c) => c.component)).toEqual(a.components.map((c) => c.component));
    expect(b.rows.length).toBe(a.rows.length);
  });
});

describe('method names come from the descriptors, not from a hand-written list', () => {
  it('reports real RPC names for a service', () => {
    const rows = telemetry().rowsFor('Session', 3);
    const names = rows.map((r) => r.name);
    // These are the wire names in Session.proto. If a proto rename happened,
    // this fails here rather than the console quietly showing a stale label.
    expect(names).toContain('ListSessions');
    expect(names).toContain('EjectSession');
  });

  it('keeps the proto kind, so streaming and unary stay distinguishable', () => {
    const rows = telemetry().rowsFor('Network', 3);
    const streamLogs = rows.find((r) => r.name === 'StreamLogs');
    const registry = rows.find((r) => r.name === 'GetRegistryStatus');
    expect(streamLogs?.kind).toBe(RpcKindValue.STREAMING_SEND);
    expect(registry?.kind).toBe(RpcKindValue.UNARY);
    // msg/s is meaningful only for a streaming RPC; a unary row leaves it 0
    // rather than inventing a rate for messages that do not exist.
    expect(registry?.msgRate1s).toBe(0);
    expect(streamLogs!.msgRate1s).toBeGreaterThan(0);
    expect(registry?.direction).toBe(DirectionValue.INBOUND);
  });

  it('excludes dynamic-target entries — Admin is not a component', () => {
    // Admin is served BY every Component rather than being one, and
    // EdgeApplication belongs to an Edge client process.
    const components = telemetry().components();
    expect(components).not.toContain('Admin');
    expect(components).not.toContain('Edge Application');
    expect(components).toContain('Network');
  });
});

describe('status codes are broken out, not summed into an error blob', () => {
  it('gives PERMISSION_DENIED its own slot', () => {
    // Denials are the observable consequence of an ejection, so the panel has
    // to be able to show them apart from transport failures.
    const row = telemetry().rowsFor('Session', 40)[0]!;
    expect(row.statusCodeCounts).toHaveLength(17);
    const total = row.statusCodeCounts.reduce((a, b) => a + b, 0n);
    expect(total).toBe(row.callsTotal);
  });
});

describe('reset is honoured, because it is an operator action', () => {
  it('zeroes one component and leaves the others counting', () => {
    const t = telemetry();
    const before = t.rowsFor('Health', 100)[0]!;
    expect(before.callsTotal).toBeGreaterThan(0n);

    t.reset('Health', 100);

    expect(t.rowsFor('Health', 100)[0]!.callsTotal).toBe(0n);
    // A neighbour must be untouched — a reset that quietly zeroed the fleet
    // would look identical in a single-component panel.
    expect(t.rowsFor('Therapy', 100)[0]!.callsTotal).toBeGreaterThan(0n);
  });

  it('an empty component name resets every component, per ResetRequest', () => {
    const t = telemetry();
    expect(t.reset('', 100)).toBeGreaterThan(1);
    expect(t.rowsFor('Therapy', 100)[0]!.callsTotal).toBe(0n);
  });

  it('reports nothing reset for a component that does not exist', () => {
    expect(telemetry().reset('Nonexistent', 10)).toBe(0);
  });

  it('Network.Reset through the router clears the snapshot the console reads', () => {
    // A pinned tick, so this asserts the reset rather than how much time the
    // default clock let pass. With a free-running tick the counters are
    // legitimately non-zero on the next frame — a real fleet accumulates a
    // period between the reset and the snapshot after it.
    const r = new MockRouter({ fleet: new MockFleet({ seed: 'test' }), tick: () => 100 });
    expect(r.suiteSnapshot().rows.some((row) => row.callsTotal > 0n)).toBe(true);
    r.resetTelemetry('');
    for (const row of r.suiteSnapshot().rows) expect(row.callsTotal).toBe(0n);
  });

  it('accumulates again after a reset, rather than staying pinned at zero', () => {
    // The counterpart the pinned-tick test cannot show: a reset zeroes the
    // origin, it does not stop counting. A mock that froze at zero would make
    // a "reset telemetry" button look like it broke the feed.
    let tick = 100;
    const r = new MockRouter({ fleet: new MockFleet({ seed: 'test' }), tick: () => tick });
    r.resetTelemetry('');
    expect(r.suiteSnapshot().rows.every((row) => row.callsTotal === 0n)).toBe(true);
    tick = 130;
    expect(r.suiteSnapshot().rows.some((row) => row.callsTotal > 0n)).toBe(true);
  });
});

describe('the Admin mutators change what a later read returns', () => {
  it('SetTrace is visible in GetConfig, which is how it is read back', () => {
    // SetLogLevelResponse carries only `enabled` — there is no `previous`
    // field, so a caller cannot render "was off" from the response and the
    // honest read-back is the config.
    const r = router();
    const res = r.setLogFlag(ctx({ [ADMIN_TARGET_HEADER]: 'Health' }), 'trace', true);
    expect(res).toEqual({ enabled: true });
    expect(Object.keys(res)).not.toContain('previous');

    const cfg = r.getConfig(ctx({ [ADMIN_TARGET_HEADER]: 'Health' }), true);
    expect(JSON.parse(cfg.payload).trace_enabled).toBe(true);
    // ...and only for the service that was targeted.
    expect(
      JSON.parse(r.getConfig(ctx({ [ADMIN_TARGET_HEADER]: 'Therapy' }), true).payload)
        .trace_enabled,
    ).toBe(false);
  });

  it('GetConfig honours redact_secrets both ways', () => {
    // Redacting regardless would hide a console that forgot to ask, leaving
    // the request field dead with nobody the wiser.
    const r = router();
    expect(JSON.parse(r.getConfig(ctx(), true).payload).auth_secret).toBe('<redacted>');
    expect(JSON.parse(r.getConfig(ctx(), false).payload).auth_secret).not.toBe('<redacted>');
    expect(r.getConfig(ctx(), true).format).toBe('json');
  });

  it('Shutdown reports STOPPED, not ERROR', () => {
    // An operator's deliberate shutdown is a different condition from a
    // service that failed, and the console colours them differently.
    const r = router();
    expect(r.shutdown(ctx({ [ADMIN_TARGET_HEADER]: 'Protocol' })).accepted).toBe(true);
    expect(r.fleet.getService('Protocol')?.status).toBe(ServiceStatusValue.STOPPED);
    expect(r.getStatus(ctx({ [ADMIN_TARGET_HEADER]: 'Protocol' })).status).toBe(
      ServiceStatusValue.STOPPED,
    );
  });

  it('DrainAll and ShutdownAll fan out to every registered service', () => {
    const r = router();
    const drained = r.drainAll();
    expect(drained.entries).toHaveLength(r.fleet.listServices().length);
    expect(drained.entries.every((e) => e.drain.accepted)).toBe(true);

    const stopped = r.shutdownAll();
    expect(stopped.entries.every((e) => e.shutdown.accepted)).toBe(true);
    expect(r.fleet.listServices().every((s) => s.status === ServiceStatusValue.STOPPED)).toBe(true);
  });
});
