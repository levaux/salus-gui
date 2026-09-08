/**
 * @salus-gui/theme — design tokens plus the one DOM helper that applies them.
 *
 * The CSS is imported by the app (`app.css` `@import`s the four files); this
 * module owns only the two attributes that select between them, so there is
 * exactly one writer of `data-theme` and `data-env`. Third-party stylesheets
 * can then target those attributes and stay in step.
 */

export type ThemeScheme = 'light' | 'dark' | 'system';

/**
 * Which backend the console is pointed at. `mock` is a first-class member
 * rather than a flavour of `dev`: an operator must be able to tell at a glance
 * that what they are looking at is fabricated.
 */
export type Environment = 'dev' | 'mock' | 'staging' | 'prod';

export interface ThemeOptions {
  scheme?: ThemeScheme;
  env?: Environment;
}

/** The severity levels `Salus.Admin.LogLevel` can carry, lowercased. */
export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'alarm',
  'error',
  'fatal',
  'test',
] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

/** The states `Salus.Common.ServiceStatus` can carry, lowercased. */
export const SERVICE_STATUSES = [
  'unknown',
  'starting',
  'running',
  'degraded',
  'stopped',
  'error',
] as const;
export type ServiceStatusName = (typeof SERVICE_STATUSES)[number];

/** The CSS custom property carrying a log level's colour. */
export function severityVar(level: LogLevelName): string {
  return `var(--sev-${level})`;
}

/** The CSS custom property carrying a service status's colour. */
export function statusVar(status: ServiceStatusName): string {
  return `var(--status-${status})`;
}

/**
 * Write the theme attributes on the document element.
 *
 * `scheme: 'system'` REMOVES `data-theme` rather than setting it, which is what
 * hands control back to the `prefers-color-scheme` media query in dark.css.
 * Setting it to a computed value instead would freeze the choice at load time
 * and stop tracking the OS.
 */
export function applyTheme(opts: ThemeOptions, root?: HTMLElement): void {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!el) return;

  if (opts.scheme !== undefined) {
    if (opts.scheme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', opts.scheme);
  }
  if (opts.env !== undefined) el.setAttribute('data-env', opts.env);
}
