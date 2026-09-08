import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The dark scheme is declared twice — once for `[data-theme='dark']` (an
 * explicit choice) and once inside `@media (prefers-color-scheme: dark)` for
 * `:root:not([data-theme])` (the system default). Both are necessary: the
 * explicit attribute has to win in both directions, which specificity alone
 * will not do.
 *
 * Two copies of the same thing drift, and this one drifts *silently* — a token
 * added to one block and not the other produces a page that is correct until
 * someone toggles the theme, at which point a colour resolves to nothing and
 * the element renders with an inherited or transparent value. No error, no
 * warning, no failing build.
 *
 * This test is the gate. It caught exactly that during `v0.2.1`: `--accent-data`
 * was added to the media block only.
 */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

/** Token declarations inside one `{ … }` block, as a name → value map. */
function tokensOf(css: string, startAfter: string): Map<string, string> {
  const start = css.indexOf(startAfter);
  if (start === -1) throw new Error(`block not found: ${startAfter}`);
  const open = css.indexOf('{', start);
  // Walk braces so a nested block ends at the right place.
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open + 1, end);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

describe('the two dark-scheme blocks stay identical', () => {
  const css = read('dark.css');
  const explicit = tokensOf(css, "[data-theme='dark']");
  const system = tokensOf(css, '@media (prefers-color-scheme: dark)');

  it('declares the same token names in both', () => {
    // Sorted so the failure message names the missing token rather than
    // reporting that two long lists differ somewhere.
    expect([...system.keys()].sort()).toEqual([...explicit.keys()].sort());
  });

  it('gives every token the same value in both', () => {
    for (const [name, value] of explicit) {
      expect(system.get(name), `${name} differs between the dark blocks`).toBe(value);
    }
  });

  it('defines a value for every token the light scheme defines', () => {
    // A token that exists only in light resolves to nothing in dark. The
    // reverse is fine — dark lifts a few values light does not need.
    const light = tokensOf(read('light.css'), ':root');
    const missing = [...light.keys()].filter((k) => !explicit.has(k));
    expect(missing).toEqual([]);
  });
});
