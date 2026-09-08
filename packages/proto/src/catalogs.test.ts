import { describe, expect, it } from 'vitest';
import {
  CATALOG_PORT_BASE,
  SERVICE_CATALOG,
  allProcedures,
  isForwardable,
  methodsOf,
  rebasePort,
  serviceById,
} from './services.js';
import { MUTATING_RPCS, isMutating } from './mutating.js';

/**
 * Drift gates over the two hand-maintained catalogs. Both are mirrors of the
 * vendored contract, and a mirror that silently stops matching is worse than
 * no mirror: an unlisted mutator is a call read-only mode permits.
 */
describe('SERVICE_CATALOG', () => {
  it('has unique ids', () => {
    const ids = SERVICE_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries a real service descriptor per entry', () => {
    for (const entry of SERVICE_CATALOG) {
      expect(entry.service, `${entry.id} has no descriptor`).toBeDefined();
      const svc = entry.service as { typeName?: string; method?: Record<string, unknown> };
      expect(typeof svc.typeName, `${entry.id} descriptor has no typeName`).toBe('string');
      expect(Object.keys(svc.method ?? {}).length, `${entry.id} has no methods`).toBeGreaterThan(0);
    }
  });

  it('uses ports in the Salus service band, or marks itself dynamic', () => {
    for (const entry of SERVICE_CATALOG) {
      if (entry.dynamicTarget) continue;
      expect(entry.port, `${entry.id}`).toBeGreaterThanOrEqual(57000);
      expect(entry.port, `${entry.id}`).toBeLessThan(58000);
    }
  });

  it('keeps console ports out of the Salus bands', () => {
    // The bridge (56400) and mock hub (56800) must not collide with a service
    // (57xxx) or a test process (58xxx) — that is why they sit below both.
    for (const consolePort of [56400, 56800]) {
      expect(SERVICE_CATALOG.some((s) => s.port === consolePort)).toBe(false);
    }
  });

  it('rebases the whole catalog onto a mock hub base', () => {
    expect(rebasePort(CATALOG_PORT_BASE, 56800)).toBe(56800);
    expect(rebasePort(57010, 56800)).toBe(56810);
    expect(rebasePort(57050, 56800)).toBe(56850);
  });

  it('finds entries by id', () => {
    expect(serviceById('network')?.label).toBe('Network');
    expect(serviceById('nope')).toBeUndefined();
  });
});

describe('methodsOf', () => {
  it('builds wire paths from the PROTO name, not the descriptor key', () => {
    // The trap this helper exists to close: protobuf-es keys methods by
    // camelCase local name while the wire uses the proto name. Routing on the
    // key yields paths the backend answers with UNIMPLEMENTED, and no type
    // error warns you. Admin.Drain is the canonical example.
    const admin = methodsOf(serviceById('admin')!);
    const drain = admin.find((m) => m.localName === 'drain');
    expect(drain).toBeDefined();
    expect(drain!.name).toBe('Drain');
    expect(drain!.procedure).toBe('Salus.Admin.Admin/Drain');
    expect(drain!.procedure).not.toContain('/drain');
  });

  it('classifies streaming kinds', () => {
    const admin = methodsOf(serviceById('admin')!);
    expect(admin.find((m) => m.name === 'Ping')!.kind).toBe('unary');
    expect(admin.find((m) => m.name === 'StreamLogs')!.kind).toBe('server_streaming');
  });

  it('refuses to forward the Edge ingest bidis to a browser', () => {
    // Decision 4: StreamHealth/StreamTherapy are the Edge's acknowledged
    // ingest sessions. The console observes their effects through query and
    // subscribe surfaces; it never carries the session itself.
    const health = methodsOf(serviceById('health')!);
    const streamHealth = health.find((m) => m.name === 'StreamHealth')!;
    expect(streamHealth.kind).toBe('bidi_streaming');
    expect(isForwardable(streamHealth)).toBe(false);

    const therapy = methodsOf(serviceById('therapy')!);
    const streamTherapy = therapy.find((m) => m.name === 'StreamTherapy')!;
    expect(isForwardable(streamTherapy)).toBe(false);

    // …while the surfaces the console actually uses are forwardable.
    expect(isForwardable(health.find((m) => m.name === 'QueryHealthSamples')!)).toBe(true);
    expect(isForwardable(health.find((m) => m.name === 'SubscribeHealthEvents')!)).toBe(true);
  });

  it('enumerates every addressable procedure', () => {
    const all = allProcedures();
    expect(all).toContain('Salus.Network.Network/GetRegistryStatus');
    expect(all).toContain('Salus.EdgeApplication.EdgeApplication/ListDueRoutines');
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('MUTATING_RPCS', () => {
  it('names procedures that exist in the generated descriptors', () => {
    // The vendored descriptors are the authority. A listed RPC whose method no
    // longer exists means the platform renamed or removed it, and the
    // read-only guard for it has silently become dead weight — a gate that
    // matches nothing looks identical to one that works.
    const known = new Set(allProcedures());
    for (const rpc of MUTATING_RPCS) {
      expect(known.has(rpc), `${rpc} is listed as mutating but no such method exists`).toBe(true);
    }
  });

  it('classifies with and without a leading slash', () => {
    expect(isMutating('Salus.Session.Session/EjectSession')).toBe(true);
    expect(isMutating('/Salus.Session.Session/EjectSession')).toBe(true);
    expect(isMutating('Salus.Session.Session/ListSessions')).toBe(false);
  });

  it('lists the calls that stop or reconfigure a live fleet', () => {
    // Spot-check the ones whose absence would be most dangerous, rather than
    // asserting the whole set (which would just restate the source file).
    for (const rpc of [
      'Salus.Admin.Admin/Shutdown',
      'Salus.Admin.Admin/Drain',
      'Salus.Network.Network/ShutdownAll',
      'Salus.Network.Network/DrainAll',
      'Salus.Session.Session/EjectSession',
      'Salus.Protocol.Protocol/PublishProtocolRevision',
      'Salus.Protocol.Protocol/AllocateProtocol',
      'Salus.EdgeApplication.EdgeApplication/StartRoutine',
    ]) {
      expect(isMutating(rpc), `${rpc} must be gated`).toBe(true);
    }
  });

  it('does not gate pure reads', () => {
    for (const rpc of [
      'Salus.Admin.Admin/Ping',
      'Salus.Admin.Admin/GetStatus',
      'Salus.Network.Network/GetRegistryStatus',
      'Salus.Health.Health/QueryHealthSamples',
      'Salus.Therapy.Therapy/ListActiveTherapies',
      'Salus.Protocol.Protocol/ValidateProtocolCandidate',
      'Salus.EdgeApplication.EdgeApplication/GetApplicationState',
    ]) {
      expect(isMutating(rpc), `${rpc} should not be gated`).toBe(false);
    }
  });
});
