/**
 * @salus-gui/proto — the vendored Salus contract surface.
 *
 * The generated code under `src/gen/` is NOT committed: it is rebuilt by
 * `pnpm gen` (and by this package's `postinstall`, so a fresh checkout
 * typechecks after a plain `pnpm install`). It is fully determined by the
 * drift-gated vendored `.proto` sources plus the pinned buf toolchain, which
 * is why there is nothing to diff and no regenerate-and-diff gate.
 *
 * Import generated types from `@salus-gui/proto/gen/<File>_pb.js`; this module
 * re-exports only the hand-written surface.
 */
export * from './well-known.js';
export * from './services.js';
export * from './mutating.js';
