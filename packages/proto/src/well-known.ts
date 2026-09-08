/**
 * well-known — the single place Salus.Common scalar wrappers are converted.
 *
 * Two wire types need care, and both are `int64` underneath, which protobuf-es
 * v2 surfaces as `bigint`:
 *
 *   Timestamp { int64 seconds; int32 nanos }   — seconds since the Unix epoch
 *   Decimal   { int64 unscaled; int32 scale }  — value = unscaled * 10^(-scale)
 *
 * An eslint rule (`salus-gui/decimal-choke-point`) bans `.unscaled` and
 * `.scale` member access everywhere except this module and its test. That is
 * not style policing: a Decimal read field-by-field somewhere in a panel is
 * how a number silently loses its scale, and a value rendered at the wrong
 * scale looks entirely plausible. Every conversion goes through here, and
 * nothing here ever converts through `number` — `Number(unscaled)` is lossy
 * above 2^53 and rounds binary-invisibly below it.
 *
 * Salus also carries a great many raw `int64 *_us` fields (`as_of_us`,
 * `scheduled_for_us`, `timestamp_us`) rather than a Timestamp message, so the
 * microsecond helpers are first-class here too.
 */
import type { Decimal, Timestamp } from './gen/Common_pb.js';

const MICROS_PER_SECOND = 1_000_000n;
const NANOS_PER_MICRO = 1_000n;
const NANOS_PER_SECOND = 1_000_000_000n;

/** Floor division for bigints. `/` truncates toward zero, which is wrong for negatives. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

/** Whole microseconds since the Unix epoch. Sub-microsecond nanos are truncated. */
export function tsToMicros(ts: Timestamp): bigint {
  return ts.seconds * MICROS_PER_SECOND + floorDiv(BigInt(ts.nanos), NANOS_PER_MICRO);
}

/** Build a Timestamp from whole microseconds since the epoch. `nanos` stays in [0, 1e9). */
export function microsToTs(micros: bigint): Timestamp {
  const seconds = floorDiv(micros, MICROS_PER_SECOND);
  const remainder = micros - seconds * MICROS_PER_SECOND;
  return {
    $typeName: 'Salus.Common.Timestamp',
    seconds,
    nanos: Number(remainder * NANOS_PER_MICRO),
  } as Timestamp;
}

/**
 * A JS `Date` for display. Lossy by construction — Date holds milliseconds —
 * so never round-trip through this to get back to the wire; keep the bigint.
 */
export function tsToDate(ts: Timestamp): Date {
  return new Date(Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000));
}

export function dateToTs(d: Date): Timestamp {
  const ms = BigInt(d.getTime());
  const seconds = floorDiv(ms, 1000n);
  return {
    $typeName: 'Salus.Common.Timestamp',
    seconds,
    nanos: Number((ms - seconds * 1000n) * 1_000_000n),
  } as Timestamp;
}

/** A `Date` from a raw `*_us` field. Same lossiness caveat as `tsToDate`. */
export function microsToDate(micros: bigint): Date {
  return new Date(Number(floorDiv(micros, NANOS_PER_MICRO)));
}

/** True when the timestamp is the unset default (0s, 0ns) rather than the epoch itself. */
export function tsIsUnset(ts: Timestamp | undefined): boolean {
  return ts === undefined || (ts.seconds === 0n && ts.nanos === 0);
}

/** Total ordering over Timestamps: -1, 0, 1. */
export function tsCompare(a: Timestamp, b: Timestamp): number {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  if (a.nanos !== b.nanos) return a.nanos < b.nanos ? -1 : 1;
  return 0;
}

/** Nanoseconds since the epoch — for the few surfaces that report at that resolution. */
export function tsToNanos(ts: Timestamp): bigint {
  return ts.seconds * NANOS_PER_SECOND + BigInt(ts.nanos);
}

// ---------------------------------------------------------------------------
// Decimal
// ---------------------------------------------------------------------------

/**
 * Exact decimal text. No float anywhere on this path: the digits are produced
 * from the bigint and the point is inserted by string surgery.
 */
export function decToString(d: Decimal): string {
  const negative = d.unscaled < 0n;
  const digits = (negative ? -d.unscaled : d.unscaled).toString();
  const sign = negative ? '-' : '';

  // A non-positive scale means the value is scaled UP: append zeros.
  if (d.scale <= 0) return sign + digits + '0'.repeat(-d.scale);

  const padded = digits.padStart(d.scale + 1, '0');
  const cut = padded.length - d.scale;
  return sign + padded.slice(0, cut) + '.' + padded.slice(cut);
}

/**
 * Parse exact decimal text. The scale is taken from the input's own fraction
 * length, so `"1.50"` and `"1.5"` produce different (equal-valued) Decimals —
 * which is correct: the trailing zero is significance the operator typed.
 */
export function decFromString(text: string): Decimal {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) throw new Error(`not a decimal: ${JSON.stringify(text)}`);
  const [, sign, whole, fraction = ''] = match;
  const unscaled = BigInt(`${sign === '-' ? '-' : ''}${whole}${fraction}`);
  return {
    $typeName: 'Salus.Common.Decimal',
    unscaled,
    scale: fraction.length,
  } as Decimal;
}

/** Total ordering by VALUE, across differing scales: -1, 0, 1. */
export function decCompare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = a.unscaled * 10n ** BigInt(scale - a.scale);
  const right = b.unscaled * 10n ** BigInt(scale - b.scale);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Value equality — `1.50` equals `1.5`, unlike a field-by-field comparison. */
export function decEquals(a: Decimal, b: Decimal): boolean {
  return decCompare(a, b) === 0;
}

export function decIsZero(d: Decimal): boolean {
  return d.unscaled === 0n;
}

/**
 * A `number`, for charting only, where an axis cannot hold a bigint anyway.
 * Never use this for display of a value the operator reads as authoritative,
 * and never send the result back to the wire.
 */
export function decToNumber(d: Decimal): number {
  return Number(decToString(d));
}
