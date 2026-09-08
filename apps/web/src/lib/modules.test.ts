import { describe, expect, it } from 'vitest';
import { MODULES } from './modules.js';

describe('module registry', () => {
  it('has unique ids and routes', () => {
    const ids = MODULES.map((m) => m.id);
    const routes = MODULES.map((m) => m.route);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('ships exactly one enabled destination in the scaffold', () => {
    // The walking skeleton proves one path end to end. When a later stage
    // enables a module, this expectation moves with it deliberately rather
    // than a half-built panel appearing unannounced.
    const enabled = MODULES.filter((m) => m.enabled);
    expect(enabled.map((m) => m.id)).toEqual(['fleet']);
  });

  it('says why a disabled module is not here yet', () => {
    // A greyed entry with no explanation is worse than a hidden one: the
    // operator cannot tell broken from unbuilt.
    for (const m of MODULES.filter((m) => !m.enabled)) {
      expect(m.note, m.id).toBeTruthy();
      expect(m.note, m.id).toMatch(/plan/i);
    }
  });

  it('routes the enabled module at the root', () => {
    expect(MODULES.find((m) => m.id === 'fleet')?.route).toBe('/');
  });
});
