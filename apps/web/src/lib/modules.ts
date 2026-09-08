/**
 * modules — the nav rail's registry.
 *
 * One entry per destination. `enabled: false` renders the entry greyed with its
 * plan number rather than hiding it: an operator should be able to see what the
 * console will grow into, and a hidden feature is one nobody asks about.
 */
export interface ModuleEntry {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  /** A short glyph for the rail. */
  readonly icon: string;
  readonly enabled: boolean;
  /** Why it is not here yet, when it is not. */
  readonly note?: string;
}

export const MODULES: readonly ModuleEntry[] = [
  {
    id: 'fleet',
    title: 'Fleet',
    route: '/',
    icon: '◉',
    enabled: true,
  },
  {
    id: 'harness',
    title: 'Harness',
    route: '/harness',
    icon: '▶',
    enabled: false,
    note: 'Regression console — plan 002 (v0.2.3)',
  },
  {
    id: 'session',
    title: 'Session',
    route: '/session',
    icon: '⎔',
    enabled: false,
    note: 'Sessions, ejection, protocol — plan 002 (v0.2.5)',
  },
  {
    id: 'data',
    title: 'Data',
    route: '/data',
    icon: '◫',
    enabled: false,
    note: 'Health & therapy observation — plan 002 (v0.2.6)',
  },
] as const;
