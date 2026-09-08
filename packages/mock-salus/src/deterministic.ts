/**
 * deterministic — the seeded generator every mock answer is derived from.
 *
 * The rule this package is built on: **a value is a pure function of
 * `(seed, …coordinates)`**, never of a clock or `Math.random`. The same seed
 * therefore produces byte-identical output on every run, on every machine, and
 * — crucially — a window slice is independent of how it was reached. Ask for
 * hour 5 directly or scroll to it, you get the same numbers.
 *
 * That is the same discipline Salus's own `SalusHealth` simulator holds itself
 * to, and it is what lets vitest assert exact frames instead of "roughly a
 * number". A mock that drifts between runs cannot be asserted against, so it
 * ends up asserted around — which is how a test suite stops noticing things.
 */

/**
 * A 32-bit mix (SplitMix32). Fast, dependency-free, and good enough for
 * fixtures: the requirement is reproducibility and even spread, not
 * cryptographic quality.
 */
export function hash32(...coords: (number | string)[]): number {
  let h = 0x9e3779b9;
  for (const c of coords) {
    const s = typeof c === 'string' ? c : String(c);
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b);
      h = (h ^ (h >>> 13)) >>> 0;
    }
    h = Math.imul(h ^ 0x165667b1, 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h >>> 0;
}

/** A reproducible float in [0, 1) from a coordinate tuple. */
export function unit(...coords: (number | string)[]): number {
  return hash32(...coords) / 0x1_0000_0000;
}

/** A reproducible integer in [min, max]. */
export function intBetween(min: number, max: number, ...coords: (number | string)[]): number {
  return min + Math.floor(unit(...coords) * (max - min + 1));
}

/** A reproducible pick from a non-empty list. */
export function pick<T>(items: readonly T[], ...coords: (number | string)[]): T {
  if (items.length === 0) throw new RangeError('pick() needs a non-empty list');
  return items[intBetween(0, items.length - 1, ...coords)]!;
}

/**
 * A smooth-ish reproducible value in [min, max] that varies with `tick` —
 * for metric series that should look like a signal rather than noise.
 */
export function wave(
  tick: number,
  min: number,
  max: number,
  ...coords: (number | string)[]
): number {
  const phase = unit(...coords) * Math.PI * 2;
  const period = 60 + intBetween(0, 40, ...coords, 'period');
  const t = Math.sin((tick / period) * Math.PI * 2 + phase); // [-1, 1]
  const jitter = (unit(...coords, tick) - 0.5) * 0.1;
  const scaled = (t + 1) / 2 + jitter; // ~[0, 1]
  const clamped = Math.min(1, Math.max(0, scaled));
  return min + clamped * (max - min);
}
