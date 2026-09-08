import { describe, expect, it } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { SERVICE_CATALOG } from '@salus-gui/proto/services';
import { SiteContext, resolvePort, type Site } from './services.js';

const mockSite: Site = {
  id: 'dev-mock',
  name: 'Mock',
  env: 'mock',
  services: { host: '127.0.0.1', portBase: 56800 },
};

const realSite: Site = {
  id: 'dev-local',
  name: 'Local',
  env: 'dev',
  services: { host: '10.0.0.5' },
};

describe('port resolution', () => {
  it('rebases the whole catalog onto a hub base', () => {
    expect(resolvePort(mockSite.services, 57000)).toBe(56800); // Network
    expect(resolvePort(mockSite.services, 57030)).toBe(56830); // Health
    expect(resolvePort(mockSite.services, 57050)).toBe(56850); // Protocol
  });

  it('leaves real ports alone when no base is given', () => {
    for (const entry of SERVICE_CATALOG) {
      expect(resolvePort(realSite.services, entry.port)).toBe(entry.port);
    }
  });
});

describe('SiteContext', () => {
  it('resolves a transport per catalog entry', () => {
    const ctx = new SiteContext(mockSite);
    for (const entry of SERVICE_CATALOG) {
      expect(ctx.transports.get(entry.id), entry.id).toBeDefined();
    }
  });

  it('takes read-only from the site, and lets it be flipped', () => {
    expect(new SiteContext({ ...mockSite, readOnly: true }).readOnly).toBe(true);
    const ctx = new SiteContext(mockSite);
    expect(ctx.readOnly).toBe(false);
    ctx.readOnly = true;
    expect(ctx.readOnly).toBe(true);
  });
});

describe('the admin target is a browser-supplied address', () => {
  it('accepts the site host and loopback', () => {
    const ctx = new SiteContext(realSite);
    expect(ctx.adminTransportFor('10.0.0.5:57030')).toBeDefined();
    expect(ctx.adminTransportFor('127.0.0.1:57030')).toBeDefined();
    expect(ctx.adminTransportFor('localhost:57030')).toBeDefined();
  });

  it('refuses any other host — the bridge is not an open proxy', () => {
    // Without this pin, anything that can reach the console could dial
    // arbitrary hosts through the bridge.
    const ctx = new SiteContext(realSite);
    for (const addr of ['evil.example.com:80', '169.254.169.254:80', '10.0.0.99:57000']) {
      try {
        ctx.adminTransportFor(addr);
        throw new Error(`expected ${addr} to be refused`);
      } catch (err) {
        expect(err, addr).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).code, addr).toBe(Code.PermissionDenied);
      }
    }
  });

  it('refuses a malformed address', () => {
    const ctx = new SiteContext(realSite);
    for (const addr of ['no-port', '127.0.0.1:', '127.0.0.1:0', '127.0.0.1:99999', ':57000']) {
      try {
        ctx.adminTransportFor(addr);
        throw new Error(`expected ${addr} to be refused`);
      } catch (err) {
        expect(err, addr).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).code, addr).toBe(Code.InvalidArgument);
      }
    }
  });

  it('pools transports per address', () => {
    const ctx = new SiteContext(realSite);
    expect(ctx.adminTransportFor('127.0.0.1:57030')).toBe(ctx.adminTransportFor('127.0.0.1:57030'));
  });

  it('rebases a loopback admin address onto the mock hub', () => {
    // A service registers the loopback address IT binds. From a bridge on
    // another machine that loopback is the bridge's own box, where nothing is
    // listening — so it is rewritten to the site host and rebased like the
    // catalog transports.
    const ctx = new SiteContext(mockSite);
    expect(ctx.adminTransportFor('127.0.0.1:57030')).toBeDefined();
    expect(resolvePort(mockSite.services, 57030)).toBe(56830);
  });
});
