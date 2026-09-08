import { describe, expect, it, vi } from 'vitest';
import { ConnectionManager, type Reconnectable } from './connection-manager.js';

function fakeController(label: string): Reconnectable & { reconnect: ReturnType<typeof vi.fn> } {
  return { label, reconnect: vi.fn() };
}

describe('ConnectionManager', () => {
  it('reports degraded when the probe fails, and up when it recovers', async () => {
    let ok = true;
    const changes: string[] = [];
    const m = new ConnectionManager({
      probe: async () => ok,
      onHealthChange: (h) => changes.push(h),
    });

    expect(m.getHealth()).toBe('up');
    ok = false;
    await m.tick();
    expect(m.getHealth()).toBe('degraded');

    ok = true;
    await m.tick();
    expect(m.getHealth()).toBe('up');
    expect(changes).toEqual(['degraded', 'up']);
  });

  it('treats a throwing probe as degraded', async () => {
    const m = new ConnectionManager({
      probe: async () => {
        throw new Error('unreachable');
      },
    });
    await m.tick();
    expect(m.getHealth()).toBe('degraded');
  });

  it('mass-reconnects every controller on recovery only', async () => {
    let ok = true;
    const a = fakeController('a');
    const b = fakeController('b');
    const m = new ConnectionManager({ probe: async () => ok });
    m.register(a);
    m.register(b);

    // Staying up must not reconnect anything — that would be a stampede on
    // every poll.
    await m.tick();
    expect(a.reconnect).not.toHaveBeenCalled();

    ok = false;
    await m.tick();
    expect(a.reconnect).not.toHaveBeenCalled(); // going down is not recovery

    ok = true;
    await m.tick();
    expect(a.reconnect).toHaveBeenCalledTimes(1);
    expect(b.reconnect).toHaveBeenCalledTimes(1);
  });

  it('stops reconnecting a controller once unregistered', async () => {
    let ok = true;
    const a = fakeController('a');
    const m = new ConnectionManager({ probe: async () => ok });
    const off = m.register(a);
    off();

    ok = false;
    await m.tick();
    ok = true;
    await m.tick();
    expect(a.reconnect).not.toHaveBeenCalled();
  });

  it('drops a re-entrant probe rather than queueing it', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const m = new ConnectionManager({
      probe: async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await Promise.resolve();
        inFlight--;
        return true;
      },
    });

    await Promise.all([m.tick(), m.tick(), m.tick()]);
    expect(maxConcurrent).toBe(1);
  });

  it('accepts a direct health report without a probe round-trip', async () => {
    const a = fakeController('a');
    const m = new ConnectionManager({ probe: async () => true });
    m.register(a);

    m.reportHealth('degraded');
    expect(m.getHealth()).toBe('degraded');
    m.reportHealth('up');
    expect(a.reconnect).toHaveBeenCalledTimes(1);
  });

  it('polls on an injected interval and stops cleanly', () => {
    const handles: Array<() => void> = [];
    const m = new ConnectionManager({
      probe: async () => true,
      setInterval: (cb) => {
        handles.push(cb);
        return handles.length as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => handles.pop(),
    });

    m.start();
    m.start(); // idempotent — a second timer would double the poll rate
    expect(handles).toHaveLength(1);
    m.stop();
    expect(handles).toHaveLength(0);
  });
});
