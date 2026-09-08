# Commit History

Version history for the salus-gui console, grouped by major/minor release. The `"version"` in the
root `package.json` is the single source of truth; bump it with each versioned commit and add a row
here. Non-versioned commits (`docs:` / `proto:` / `test:` / `infra:` / `chore:` / `fix:`) get no
row — `git log` carries them.

---

## v0.1 — Workspace Scaffold (in progress)

The first release train ([docs/plans/001-salus-gui-repo.md](plans/001-salus-gui-repo.md)), taking
the repository from planning apparatus to a **walking skeleton**: every layer present, CI green on
a fresh checkout, and one genuinely live panel — fleet status + aggregated logs — working against
both the deterministic mock and a real running Salus fleet. Releases as `v0.2.0`.

| Version | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1.2  | **`@salus-gui/proto`: vendoring pipeline, codegen and catalogs.** `tools/sync-protos.ts` vendors the 10 `Salus/*.proto` files from the sibling repo and pins them in `salus-commit.lock` (SHA + per-file sha256); `--check` hashes the vendored copies rather than the source, so the drift gate needs no Salus checkout. buf v2 + protoc-gen-es v2 generate into an **untracked** `src/gen` via the package's `postinstall`, and `.buf-image-prev.binpb` is committed as the wire-compat baseline — recorded state, not derivable output. Three hand-written modules: `well-known.ts` (the Timestamp/Decimal choke point — bigint throughout, never `number`), `services.ts` (the 8-service catalog, `methodsOf()` mapping descriptor local names to wire proto names, `isForwardable()` refusing the Edge ingest bidis), and `mutating.ts` (the read-only guard's curated allow-list, over-listing deliberately). CI gains the drift gate, `buf breaking`, `typecheck` and `test`. Verified: 34 tests pass, both proto gates proven non-vacuous (a renumbered `Decimal.unscaled` fails `breaking`; an edited vendor file fails the drift check), and the catalog drift test caught a real defect during authoring — the mutating set had been written against descriptor keys (`drain`) rather than wire names (`Drain`). Pinned at Salus `2470b82` (v0.8.5). |
| v0.1.1  | **Workspace, toolchain and CI skeleton.** Opens the train. pnpm workspace (`packages/*`, `apps/*`) + root `package.json` (the full script surface, `packageManager` pinned, Node ≥ 22), `tsconfig.base.json` (ES2022, `bundler` resolution, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, `composite`, `@salus-gui/*` paths) and the solution `tsconfig.json`, eslint flat config, prettier, and `.github/workflows/ci.yml` (plans-lint before install — it is stdlib-only Python — then lint). Two project guards land with the config rather than after it: the `well-known.ts` Decimal choke point (`.unscaled`/`.scale` banned everywhere else) and `no-console` outside the bridge. `typecheck` and `check` are root scripts but **not yet CI steps** — `tsc -b` refuses a solution with no project references and `--filter @salus-gui/web` cannot resolve before the app exists; each joins CI in the stage that gives it something to check (v0.1.2, v0.1.6). `docs/plans/INDEX.md` is prettier-ignored: it carries a generated section, and one file gets one formatting authority. Verified: `pnpm install` clean, `pnpm lint` green, and the plans lint proved non-vacuous by failing on a renumbered-plan fixture.                                                                                                          |

---

## v0.0 — Bootstrap

The pre-scaffold state: the repository exists, carrying the planning and agent-management
apparatus (CLAUDE.md, `.claude/`, `docs/plans/` + INDEX, this file) but no product code — and
therefore no `package.json` to version, so the bootstrap ships as `chore:` commits and this
section has no version table. The `v0.1.x` series opens when
[docs/plans/001-salus-gui-repo.md](plans/001-salus-gui-repo.md) starts — the workspace scaffold, the
proto vendoring pipeline, the bridge, and the SPA shell.

The second bootstrap commit converted the plans register to the location-based lifecycle
(`backlog/` unnumbered → `NNN-<name>.md` at promotion → `completed/NNN-<name>.md`, numbers never
reused) and landed its tooling: `tools/plans.py` (sync / render-index / check / move — moves a
plan AND rewrites every inbound reference in one pass) and `tools/check-plans.py` (the register
lint: numbered ⟺ listed, `**Status**:` lines, backlog freshness, no dangling plan links).
