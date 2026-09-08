import { describe, expect, it } from 'vitest';
import {
  UNKNOWN,
  count,
  duration,
  levelName,
  statusName,
  streamLabel,
  timeOfDay,
} from './format.js';

describe('catalog mapping', () => {
  it('maps every ServiceStatus member', () => {
    // The proto's order: UNKNOWN STARTING RUNNING DEGRADED STOPPED ERROR.
    expect(statusName(0)).toBe('unknown');
    expect(statusName(1)).toBe('starting');
    expect(statusName(2)).toBe('running');
    expect(statusName(3)).toBe('degraded');
    expect(statusName(4)).toBe('stopped');
    expect(statusName(5)).toBe('error');
  });

  it('maps every LogLevel member, allowing for the reserved 0', () => {
    // LOG_LEVEL_UNSPECIFIED = 0, so TRACE is 1 and the array is offset by one.
    // Getting this off by one would mis-colour every line in the console.
    expect(levelName(1)).toBe('trace');
    expect(levelName(2)).toBe('debug');
    expect(levelName(3)).toBe('info');
    expect(levelName(4)).toBe('warn');
    expect(levelName(5)).toBe('alarm');
    expect(levelName(6)).toBe('error');
    expect(levelName(7)).toBe('fatal');
    expect(levelName(8)).toBe('test');
  });

  it('never invents a member for an out-of-range value', () => {
    // A future platform enum member must degrade visibly, not crash or borrow
    // an unrelated colour.
    expect(statusName(99)).toBe('unknown');
    expect(statusName(undefined)).toBe('unknown');
    expect(levelName(99)).toBe('trace');
    expect(levelName(0)).toBe('trace');
    expect(levelName(undefined)).toBe('trace');
  });
});

describe('empty values are explicit', () => {
  it('renders an unknown input as the marker, never as zero', () => {
    // A console showing 0 for "not measured" teaches its operator to trust a
    // number that was never taken.
    expect(count(undefined)).toBe(UNKNOWN);
    expect(duration(undefined)).toBe(UNKNOWN);
    expect(timeOfDay(undefined)).toBe(UNKNOWN);
    expect(count(0)).toBe('0'); // a real zero still reads as zero
  });

  it('rejects a nonsensical duration rather than rendering it', () => {
    expect(duration(-5)).toBe(UNKNOWN);
    expect(duration(Number.NaN)).toBe(UNKNOWN);
  });
});

describe('formatting', () => {
  it('scales durations', () => {
    expect(duration(45)).toBe('45s');
    expect(duration(90)).toBe('1m 30s');
    expect(duration(3700)).toBe('1h 1m');
    expect(duration(90_000)).toBe('1d 1h');
  });

  it('accepts bigint counts and durations without precision loss in range', () => {
    expect(count(1234567n)).toBe('1,234,567');
    expect(duration(3600n)).toBe('1h 0m');
  });

  it('renders a log timestamp to the millisecond', () => {
    const micros = BigInt(Date.UTC(2026, 8, 8, 1, 2, 3, 456)) * 1000n;
    // Local-time rendering, so assert the shape rather than a fixed hour.
    expect(timeOfDay(micros)).toMatch(/^\d{2}:\d{2}:03\.456$/);
  });

  it("labels stream states in an operator's words", () => {
    expect(streamLabel('live')).toBe('live');
    expect(streamLabel('backoff')).toBe('reconnecting');
    expect(streamLabel('fatal')).toBe('stopped');
    expect(streamLabel('idle')).toBe('idle');
    expect(streamLabel('anything-else')).toBe('idle');
  });
});
