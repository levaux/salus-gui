/**
 * format — the display helpers the components share.
 *
 * Pure functions, so they are unit-tested without rendering anything. Nothing
 * here fabricates a value: an absent input renders as an explicit em-dash
 * rather than a plausible zero. A console that shows `0` for "we do not know"
 * teaches its operator to trust a number that was never measured.
 */
import { LOG_LEVELS, SERVICE_STATUSES } from '@salus-gui/theme';
import type { LogLevelName, ServiceStatusName } from '@salus-gui/theme';

/** The empty marker. Deliberately not `0`, `-`, or a blank cell. */
export const UNKNOWN = '—';

/**
 * `Salus.Common.ServiceStatus` → the lowercase token the theme colours by.
 * Index 0 is UNSPECIFIED/UNKNOWN in the proto, and anything out of range is
 * `unknown` rather than a guess.
 */
export function statusName(value: number | undefined): ServiceStatusName {
  if (value === undefined) return 'unknown';
  return SERVICE_STATUSES[value] ?? 'unknown';
}

/** `Salus.Admin.LogLevel` → the theme's severity token. */
export function levelName(value: number | undefined): LogLevelName {
  // The proto reserves 0 for UNSPECIFIED, so the enum's members start at 1 and
  // the array is offset by one.
  if (value === undefined || value < 1) return 'trace';
  return LOG_LEVELS[value - 1] ?? 'trace';
}

/** A duration in seconds as a compact, scannable string. */
export function duration(seconds: number | bigint | undefined): string {
  if (seconds === undefined) return UNKNOWN;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return UNKNOWN;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** A count with thousands separators, or the empty marker. */
export function count(value: number | bigint | undefined): string {
  if (value === undefined) return UNKNOWN;
  return Number(value).toLocaleString('en-US');
}

/** Microseconds since the epoch → a wall-clock time for a log line. */
export function timeOfDay(micros: bigint | undefined): string {
  if (micros === undefined) return UNKNOWN;
  const d = new Date(Number(micros / 1000n));
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

/** How a stream's controller state reads in a badge. */
export function streamLabel(status: string): string {
  switch (status) {
    case 'live':
      return 'live';
    case 'connecting':
      return 'connecting';
    case 'backoff':
      return 'reconnecting';
    case 'fatal':
      return 'stopped';
    default:
      return 'idle';
  }
}
