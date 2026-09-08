import { describe, expect, it, vi } from 'vitest';
import { ConflatedTable, type FlushScheduler } from './conflated-table.js';

/** A scheduler the test drives by hand, so no timers are involved. */
function manualScheduler(): FlushScheduler & { run(): void } {
  let pending: (() => void) | undefined;
  return {
    request(cb) {
      pending ??= cb;
    },
    cancel() {
      pending = undefined;
    },
    run() {
      const cb = pending;
      pending = undefined;
      cb?.();
    },
  };
}

interface Row {
  id: string;
  value: number;
}

const table = (sched: FlushScheduler): ConflatedTable<string, Row> =>
  new ConflatedTable<string, Row>({ keyOf: (r) => r.id, scheduler: sched });

describe('ConflatedTable', () => {
  it('keeps only the latest row per key within a flush window', () => {
    const s = manualScheduler();
    const t = table(s);

    t.upsert({ id: 'a', value: 1 });
    t.upsert({ id: 'a', value: 2 });
    t.upsert({ id: 'a', value: 3 });
    expect(t.size).toBe(0); // nothing committed until the flush

    s.run();
    expect(t.size).toBe(1);
    expect(t.get('a')).toEqual({ id: 'a', value: 3 });
  });

  it('emits add for new keys and update for known ones', () => {
    const s = manualScheduler();
    const t = table(s);
    const api = { applyTransactionAsync: vi.fn() };
    t.toGridTransactions(api);

    t.upsert({ id: 'a', value: 1 });
    s.run();
    expect(api.applyTransactionAsync).toHaveBeenLastCalledWith({
      add: [{ id: 'a', value: 1 }],
      update: [],
      remove: [],
    });

    t.upsert({ id: 'a', value: 2 });
    s.run();
    expect(api.applyTransactionAsync).toHaveBeenLastCalledWith({
      add: [],
      update: [{ id: 'a', value: 2 }],
      remove: [],
    });
  });

  it('removes, and a remove after an upsert in one window wins', () => {
    const s = manualScheduler();
    const t = table(s);
    t.upsert({ id: 'a', value: 1 });
    s.run();

    t.upsert({ id: 'a', value: 9 });
    t.remove('a');
    s.run();
    expect(t.size).toBe(0);
  });

  it('collapses ReplacingMergeTree duplicates when keyed by the replace column', () => {
    // Salus Health/Therapy tables are ReplacingMergeTree by event_id, read
    // without FINAL — so a query legitimately returns the same event_id more
    // than once until the background merge. Keyed keep-latest IS the dedup.
    const s = manualScheduler();
    const t = table(s);

    t.upsertAll([
      { id: 'evt-1', value: 10 },
      { id: 'evt-2', value: 20 },
      { id: 'evt-1', value: 10 }, // the transient duplicate row
    ]);
    s.run();

    expect(t.size).toBe(2);
    expect(t.values().filter((r) => r.id === 'evt-1')).toHaveLength(1);
  });

  it('applySnapshot seeds, updates and EVICTS stale keys', () => {
    const s = manualScheduler();
    const t = table(s);
    t.upsert({ id: 'a', value: 1 });
    t.upsert({ id: 'b', value: 2 });
    s.run();
    expect(t.size).toBe(2);

    // 'b' is gone from the authority — a reconnect must drop it, not keep
    // showing a row that no longer exists.
    t.applySnapshot([
      { id: 'a', value: 11 },
      { id: 'c', value: 33 },
    ]);

    expect(t.snapshotKeys().sort()).toEqual(['a', 'c']);
    expect(t.get('a')).toEqual({ id: 'a', value: 11 });
    expect(t.get('b')).toBeUndefined();
  });

  it('applySnapshot discards deltas buffered from the previous connection', () => {
    const s = manualScheduler();
    const t = table(s);
    t.upsert({ id: 'stale', value: 1 }); // buffered, never flushed

    t.applySnapshot([{ id: 'fresh', value: 2 }]);

    expect(t.snapshotKeys()).toEqual(['fresh']);
    s.run(); // the abandoned buffer must not resurrect anything
    expect(t.snapshotKeys()).toEqual(['fresh']);
  });

  it('applies post-snapshot deltas on top, idempotently by key', () => {
    // The tail of the Resnapshot contract: deltas drained after the snapshot
    // are applied over it, and re-applying one changes nothing.
    const s = manualScheduler();
    const t = table(s);
    t.applySnapshot([{ id: 'a', value: 1 }]);

    t.upsert({ id: 'a', value: 2 });
    t.upsert({ id: 'a', value: 2 });
    s.run();

    expect(t.size).toBe(1);
    expect(t.get('a')).toEqual({ id: 'a', value: 2 });
  });

  it('keeps a mirror map in step across flushes', () => {
    const s = manualScheduler();
    const t = table(s);
    t.upsert({ id: 'a', value: 1 });
    s.run();

    const mirror = t.toMirrorMap();
    expect(mirror.get('a')).toEqual({ id: 'a', value: 1 });

    t.upsert({ id: 'b', value: 2 });
    s.run();
    expect(mirror.get('b')).toEqual({ id: 'b', value: 2 });

    t.remove('a');
    s.run();
    expect(mirror.has('a')).toBe(false);
  });

  it('notifies flush listeners and can be unsubscribed', () => {
    const s = manualScheduler();
    const t = table(s);
    const listener = vi.fn();
    const off = t.onFlush(listener);

    t.upsert({ id: 'a', value: 1 });
    s.run();
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    t.upsert({ id: 'b', value: 2 });
    s.run();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('seeds a newly attached grid with committed state', () => {
    const s = manualScheduler();
    const t = table(s);
    t.upsert({ id: 'a', value: 1 });
    s.run();

    const api = { applyTransactionAsync: vi.fn() };
    t.toGridTransactions(api);
    // A panel mounted after the feed started must not show an empty grid.
    expect(api.applyTransactionAsync).toHaveBeenCalledWith({ add: [{ id: 'a', value: 1 }] });
  });

  it('flushNow cancels the pending scheduled flush', () => {
    const s = manualScheduler();
    const cancel = vi.spyOn(s, 'cancel');
    const t = table(s);
    t.upsert({ id: 'a', value: 1 });
    t.flushNow();
    expect(cancel).toHaveBeenCalled();
    expect(t.size).toBe(1);
  });
});
