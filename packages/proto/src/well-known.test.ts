import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Decimal, Timestamp } from './gen/Common_pb.js';
import {
  decCompare,
  decEquals,
  decFromString,
  decIsZero,
  decToNumber,
  decToString,
  dateToTs,
  microsToTs,
  tsCompare,
  tsIsUnset,
  tsToDate,
  tsToMicros,
  tsToNanos,
} from './well-known.js';

const dec = (unscaled: bigint, scale: number): Decimal =>
  ({ $typeName: 'Salus.Common.Decimal', unscaled, scale }) as Decimal;

const ts = (seconds: bigint, nanos: number): Timestamp =>
  ({ $typeName: 'Salus.Common.Timestamp', seconds, nanos }) as Timestamp;

describe('Decimal', () => {
  it('renders the scale as written', () => {
    expect(decToString(dec(150n, 2))).toBe('1.50');
    expect(decToString(dec(15n, 1))).toBe('1.5');
    expect(decToString(dec(0n, 0))).toBe('0');
    expect(decToString(dec(5n, 3))).toBe('0.005');
    expect(decToString(dec(-5n, 3))).toBe('-0.005');
    expect(decToString(dec(-150n, 2))).toBe('-1.50');
  });

  it('scales up on a non-positive scale', () => {
    expect(decToString(dec(15n, -2))).toBe('1500');
    expect(decToString(dec(-15n, -2))).toBe('-1500');
  });

  it('survives values a double cannot hold', () => {
    // 2^53 + 1: the first integer a float64 cannot represent exactly. Any
    // implementation that touches `number` on this path loses the last digit.
    const big = 9007199254740993n;
    expect(decToString(dec(big, 0))).toBe('9007199254740993');
    expect(decToString(dec(big, 2))).toBe('90071992547409.93');
  });

  it('rejects text that is not a decimal', () => {
    for (const bad of ['', 'abc', '1.2.3', '1,5', '0x10', ' 1 2 ', 'NaN', '1e5']) {
      expect(() => decFromString(bad)).toThrow();
    }
  });

  it('parses the forms an operator types', () => {
    expect(decFromString('  1.50  ')).toEqual(dec(150n, 2));
    expect(decFromString('+1.5')).toEqual(dec(15n, 1));
    expect(decFromString('-0.005')).toEqual(dec(-5n, 3));
    expect(decFromString('42')).toEqual(dec(42n, 0));
    expect(decFromString('42.')).toEqual(dec(42n, 0));
  });

  it('compares by value across differing scales', () => {
    expect(decCompare(dec(150n, 2), dec(15n, 1))).toBe(0);
    expect(decEquals(dec(150n, 2), dec(15n, 1))).toBe(true);
    expect(decCompare(dec(1n, 0), dec(999n, 3))).toBe(1);
    expect(decCompare(dec(-1n, 0), dec(1n, 0))).toBe(-1);
  });

  it('knows zero at any scale', () => {
    expect(decIsZero(dec(0n, 7))).toBe(true);
    expect(decIsZero(dec(1n, 7))).toBe(false);
  });

  it('converts to number for charting only', () => {
    expect(decToNumber(dec(150n, 2))).toBe(1.5);
  });

  // --- properties -----------------------------------------------------------

  it('property: decFromString ∘ decToString is the identity', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.integer({ min: 0, max: 18 }), (unscaled, scale) => {
        const original = dec(unscaled, scale);
        const round = decFromString(decToString(original));
        // Value must be preserved exactly; -0 normalises to 0, so compare by value.
        expect(decEquals(round, original)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('property: decToString never produces a lossy rendering', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.integer({ min: 0, max: 18 }), (unscaled, scale) => {
        const text = decToString(dec(unscaled, scale));
        // Every digit of the unscaled magnitude survives into the text.
        const digits = text.replace(/[-.]/g, '').replace(/^0+(?=\d)/, '');
        const expected = (unscaled < 0n ? -unscaled : unscaled).toString();
        expect(digits.endsWith(expected) || expected === '0').toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('property: decCompare agrees with bigint ordering at equal scale', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), fc.integer({ min: 0, max: 12 }), (a, b, scale) => {
        const expected = a === b ? 0 : a < b ? -1 : 1;
        expect(decCompare(dec(a, scale), dec(b, scale))).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('property: decCompare is antisymmetric across scales', () => {
    const BOUND = 10n ** 15n;
    const anyDec = fc
      .tuple(fc.bigInt({ min: -BOUND, max: BOUND }), fc.integer({ min: 0, max: 12 }))
      .map(([u, s]) => dec(u, s));
    fc.assert(
      fc.property(anyDec, anyDec, (a, b) => {
        expect(decCompare(a, b)).toBe(-decCompare(b, a));
      }),
      { numRuns: 500 },
    );
  });
});

describe('Timestamp', () => {
  it('converts to and from microseconds', () => {
    // 500_000 ns is 500 µs, so one second and 500 µs is 1_000_500 µs.
    expect(tsToMicros(ts(1n, 500_000))).toBe(1_000_500n);
    expect(microsToTs(1_000_500n)).toEqual(ts(1n, 500_000));
    // Half a second, to keep the ns/µs scale honest in both directions.
    expect(tsToMicros(ts(1n, 500_000_000))).toBe(1_500_000n);
    expect(microsToTs(1_500_000n)).toEqual(ts(1n, 500_000_000));
  });

  it('keeps nanos in [0, 1e9) for pre-epoch instants', () => {
    // Truncating division would give seconds=0, nanos=-500000000 here — a
    // timestamp no protobuf consumer accepts.
    const t = microsToTs(-500_000n);
    expect(t.seconds).toBe(-1n);
    expect(t.nanos).toBe(500_000_000);
    expect(tsToMicros(t)).toBe(-500_000n);
  });

  it('converts to nanoseconds', () => {
    expect(tsToNanos(ts(2n, 5))).toBe(2_000_000_005n);
  });

  it('distinguishes unset from a real instant', () => {
    expect(tsIsUnset(undefined)).toBe(true);
    expect(tsIsUnset(ts(0n, 0))).toBe(true);
    expect(tsIsUnset(ts(0n, 1))).toBe(false);
    expect(tsIsUnset(ts(1n, 0))).toBe(false);
  });

  it('orders timestamps', () => {
    expect(tsCompare(ts(1n, 0), ts(2n, 0))).toBe(-1);
    expect(tsCompare(ts(1n, 5), ts(1n, 4))).toBe(1);
    expect(tsCompare(ts(1n, 5), ts(1n, 5))).toBe(0);
  });

  it('round-trips a Date through the wire shape', () => {
    const d = new Date('2026-09-08T02:27:09.566Z');
    expect(tsToDate(dateToTs(d)).getTime()).toBe(d.getTime());
  });

  it('property: microsToTs ∘ tsToMicros is the identity on µs-resolution values', () => {
    const BOUND = 10n ** 15n;
    fc.assert(
      fc.property(fc.bigInt({ min: -BOUND, max: BOUND }), (micros) => {
        expect(tsToMicros(microsToTs(micros))).toBe(micros);
      }),
      { numRuns: 500 },
    );
  });

  it('property: a Date round-trips through dateToTs exactly', () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (d) => {
        expect(tsToDate(dateToTs(d)).getTime()).toBe(d.getTime());
      }),
      { numRuns: 500 },
    );
  });
});
