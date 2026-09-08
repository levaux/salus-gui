import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring-buffer.js';
import { SeriesBuffer } from './series-buffer.js';

describe('RingBuffer', () => {
  it('keeps order and reports size', () => {
    const r = new RingBuffer<number>(4);
    r.pushMany([1, 2, 3]);
    expect(r.size).toBe(3);
    expect(r.snapshot()).toEqual([1, 2, 3]);
  });

  it('overwrites the oldest entries once full', () => {
    const r = new RingBuffer<number>(3);
    r.pushMany([1, 2, 3, 4, 5]);
    expect(r.size).toBe(3);
    expect(r.snapshot()).toEqual([3, 4, 5]);
  });

  it('returns the newest n, oldest first', () => {
    const r = new RingBuffer<number>(5);
    r.pushMany([1, 2, 3, 4]);
    expect(r.tail(2)).toEqual([3, 4]);
    expect(r.tail(99)).toEqual([1, 2, 3, 4]); // clamped, never padded
  });

  it('filters without an intermediate copy', () => {
    const r = new RingBuffer<number>(5);
    r.pushMany([1, 2, 3, 4]);
    expect(r.snapshot((n) => n % 2 === 0)).toEqual([2, 4]);
  });

  it('bumps generation on every mutation', () => {
    const r = new RingBuffer<number>(3);
    const g0 = r.generation;
    r.push(1);
    expect(r.generation).toBeGreaterThan(g0);
    const g1 = r.generation;
    r.clear();
    expect(r.generation).toBeGreaterThan(g1);
    expect(r.size).toBe(0);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
  });
});

describe('SeriesBuffer', () => {
  it('returns aligned columns oldest → newest', () => {
    const s = new SeriesBuffer(2, 10);
    s.push(1, [10, 100]);
    s.push(2, [20, 200]);
    expect(s.toColumns()).toEqual([
      [1, 2],
      [10, 20],
      [100, 200],
    ]);
  });

  it('wraps, keeping the columns aligned', () => {
    const s = new SeriesBuffer(1, 3);
    for (let i = 1; i <= 5; i++) s.push(i, [i * 10]);
    expect(s.toColumns()).toEqual([
      [3, 4, 5],
      [30, 40, 50],
    ]);
  });

  it('rejects a value count that does not match the series count', () => {
    const s = new SeriesBuffer(2, 4);
    // Silently accepting this would misalign every later sample.
    expect(() => s.push(1, [1])).toThrow(RangeError);
  });

  it('rejects invalid geometry', () => {
    expect(() => new SeriesBuffer(0, 10)).toThrow(RangeError);
    expect(() => new SeriesBuffer(1, 0)).toThrow(RangeError);
  });

  it('clears', () => {
    const s = new SeriesBuffer(1, 4);
    s.push(1, [1]);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.toColumns()).toEqual([[], []]);
  });
});
