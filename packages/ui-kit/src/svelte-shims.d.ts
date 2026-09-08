/**
 * svelte-shims — an ambient module declaration for `.svelte` imports.
 *
 * Plain `tsc -b` cannot parse a `.svelte` file at all: no TS or JS dialect
 * covers Svelte template syntax. Real checking of component internals is
 * `svelte-check`'s job (it compiles each component to a virtual TSX module and
 * needs no shim) — which is exactly the split decision 6 in plan 001 records,
 * and why `pnpm check` is a distinct CI gate rather than something `typecheck`
 * covers.
 *
 * This wildcard exists ONLY so the plain `.ts` files that re-export components
 * (index.ts) resolve to *something* under raw tsc. The cost is that every
 * component's default export is the same loosely-typed `Component`, and named
 * exports from a `<script module>` block are invisible through it — so any
 * value a `.ts` file needs to import stays in a sibling `.ts`, never inside a
 * component.
 */
declare module '*.svelte' {
  import type { Component } from 'svelte';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: Component<any, any, any>;
  export default component;
}
