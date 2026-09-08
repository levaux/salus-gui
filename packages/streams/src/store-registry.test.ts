import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LINGER_MS, StoreRegistry } from './store-registry.js';

/**
 * The Linger contract. Five cases, which together say: start once, stop late,
 * and never re-snapshot for a navigation the operator experiences as instant.
 */
describe('StoreRegistry — Linger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('starts once however many holders acquire it', () => {
    const reg = new StoreRegistry();
    const start = vi.fn();
    const stop = vi.fn();

    const a = reg.acquire('fleet', start, stop);
    const b = reg.acquire('fleet', start, stop);

    expect(start).toHaveBeenCalledTimes(1);
    expect(reg.holders('fleet')).toBe(2);

    // One holder leaving is not the last holder leaving.
    a();
    vi.advanceTimersByTime(DEFAULT_LINGER_MS * 2);
    expect(stop).not.toHaveBeenCalled();

    b();
    expect(stop).not.toHaveBeenCalled(); // still lingering
    vi.advanceTimersByTime(DEFAULT_LINGER_MS);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops only after the linger window', () => {
    const reg = new StoreRegistry({ lingerMs: 1000 });
    const stop = vi.fn();
    const release = reg.acquire('logs', vi.fn(), stop);

    release();
    expect(reg.isLingering('logs')).toBe(true);
    expect(reg.isRunning('logs')).toBe(true); // still live during the window

    vi.advanceTimersByTime(999);
    expect(stop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(reg.isRunning('logs')).toBe(false);
  });

  it('reuses the live feed when re-acquired inside the window', () => {
    const reg = new StoreRegistry({ lingerMs: 1000 });
    const start = vi.fn();
    const stop = vi.fn();

    const release = reg.acquire('registry', start, stop);
    release();
    vi.advanceTimersByTime(500); // half way through the linger

    // Navigating back: no re-snapshot, because nothing was ever stopped.
    const again = reg.acquire('registry', start, stop);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(reg.isLingering('registry')).toBe(false);

    // And the cancelled stop must not fire late.
    vi.advanceTimersByTime(5000);
    expect(stop).not.toHaveBeenCalled();

    again();
    vi.advanceTimersByTime(1000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('starts again after a real stop', () => {
    const reg = new StoreRegistry({ lingerMs: 100 });
    const start = vi.fn();
    const stop = vi.fn();

    reg.acquire('sessions', start, stop)();
    vi.advanceTimersByTime(100);
    expect(stop).toHaveBeenCalledTimes(1);

    reg.acquire('sessions', start, stop);
    expect(start).toHaveBeenCalledTimes(2); // genuinely restarted
  });

  it('stops immediately at lingerMs 0', () => {
    const reg = new StoreRegistry();
    const stop = vi.fn();
    reg.acquire('probe', vi.fn(), stop, { lingerMs: 0 })();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeated release', () => {
    // Component teardown is not guaranteed to run exactly once, and a double
    // release that decremented twice would stop a store another panel is
    // still holding.
    const reg = new StoreRegistry({ lingerMs: 0 });
    const stop = vi.fn();
    const a = reg.acquire('shared', vi.fn(), stop);
    reg.acquire('shared', vi.fn(), stop);

    a();
    a();
    a();
    expect(stop).not.toHaveBeenCalled();
    expect(reg.holders('shared')).toBe(1);
  });

  it('keeps separate keys independent', () => {
    const reg = new StoreRegistry({ lingerMs: 0 });
    const stopA = vi.fn();
    const stopB = vi.fn();
    const a = reg.acquire('a', vi.fn(), stopA);
    reg.acquire('b', vi.fn(), stopB);

    a();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();
  });
});
