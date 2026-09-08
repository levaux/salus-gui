# Project Configuration

## Project Overview

- **Name**: salus-gui
- **Tech Stack**: TypeScript, SvelteKit 2 + Svelte 5 (runes), Connect (connect-es) ⇄ gRPC, buf + protoc-gen-es codegen, pnpm workspaces, vitest, Node ≥ 22
- **Purpose**: The web operations console for the **Salus** platform — a dashboard for running the regression-test harness, operational control of the service fleet, and simulation/experimentation against the Edge application and the services. Built first as a development/test instrument, it carries forward as the operations-management console once the Salus platform is deployed.

The Salus backend lives in the sibling repo at `../salus` (C++17, gRPC, six services + the Edge client, an Envoy edge, a Python test harness). This repo never links against it — it vendors its protos at a pinned commit and speaks to it over the wire.

## Architecture (target — see the plans)

The browser talks to exactly one process — the **bridge** (`salus-bridged`, `:56400`) — over one h2/TLS connection:

| Browser wants                     | Bridge path                      | Backing surface                          |
|-----------------------------------|----------------------------------|------------------------------------------|
| Unary + server-stream RPC         | `/rpc` Connect ⇄ gRPC forward    | the Salus gRPC service fleet             |
| Suite runs, live harness output   | `/harness` runner endpoints      | `../salus/test/run_all.py` subprocesses  |
| Stack lifecycle (envoy, db)       | `/infra` control endpoints       | `../salus/infra/*/{up,down,status}.sh`   |
| Named workspaces, saved views     | `/kv` file-backed document store | bridge-local state                       |
| Audit log, read-only mode         | `/bridge/*` control endpoints    | bridge-local state                       |

Two planes, deliberately distinct:

- **Operator plane (default)**: the bridge dials services *directly* over h2c — the private surfaces (Admin on every Component, Network fan-out, Health/Therapy query + subscribe, Protocol operator RPCs) are deliberately not Envoy-routed, and the console is an operator-plane client.
- **Device plane (simulation)**: the JWT + ext_authz path through the Envoy edge (`:58000`) is exercised *explicitly* in the simulation panels — authenticate as a client, drive the edge-routed surface, observe ejection — never as the console's own transport.

Client/bidi-streaming RPCs (`StreamHealth`, `StreamTherapy` — the Edge's ingest sessions) are never forwarded to the browser; the console observes their effects through the query/subscribe surfaces.

### Workspace layout (target)

```
packages/
  proto/        @salus-gui/proto       vendored Salus protos + codegen + Timestamp/Decimal choke point + SERVICE_CATALOG + MUTATING_RPCS
  streams/      @salus-gui/streams     the data layer: StreamController, ConflatedTable, resnapshot/seq-resume contracts
  ui-kit/       @salus-gui/ui-kit      Svelte 5 components (dock, grid, charts, status, log views)
  theme/        @salus-gui/theme       CSS tokens, light/dark, environment accent
  mock-salus/   @salus-gui/mock-salus  deterministic TS test double of the Salus services (single hub :56800)
apps/
  bridge/       @salus-gui/bridge      salus-bridged: the browser's only counterparty (:56400)
  web/          @salus-gui/web         the SvelteKit SPA
```

### Salus service catalog (the backend this console fronts)

| Service        | Port  | Console-relevant surface |
|----------------|-------|--------------------------|
| Network        | 57000 | Registry + fleet fan-out (`GetRegistryStatus`, `GetAllStatus`, `GetAllMetrics`, `DrainAll`, `ShutdownAll`), aggregated `StreamLogs` / `StreamLifecycleEvents` / `StreamSuiteSnapshot` |
| Authentication | 57010 | `Authenticate` / `Validate`; JWKS on HTTP 57011 |
| Session        | 57020 | Session roster + **`EjectSession`** (the live-control primitive), edge bindings, device presence; ext_authz on HTTP 57021 |
| Health         | 57030 | `QueryHealthSamples` / `QueryHealthSummaries` / `GetHealthStats`, `SubscribeHealthEvents` |
| Therapy        | 57040 | Active-therapy registry + subscribes, `QueryTherapyMetrics` / `QueryTherapySessions`, `ApplyReconciliationDecision` |
| Protocol       | 57050 | Import / Validate / Publish / Allocate (operator), pull surface + `WatchAssignment` |
| Edge (client)  | own `--port` | `Salus.EdgeApplication` loopback (`ListDueRoutines`, `StartRoutine`, `SkipRoutine`, `GetApplicationState`) when run `--application-control`; harness convention 58070 |
| *every* Component | its port | `Salus.Admin.Admin` — `Ping`/`GetStatus`/`GetMetrics`/`Drain`/`Shutdown`/`SetTrace`/`SetDebug` + `StreamLogs` (seq-resumable) |

Infra: Envoy edge 58000 (admin 58009), Postgres 55432, ClickHouse 59000 native / 59123 HTTP. Console-side ports sit outside the Salus 57xxx/58xxx bands: bridge **56400**, mock hub **56800**.

## Build & Dev (once the scaffold plan lands)

```bash
corepack enable && pnpm install
pnpm gen              # buf codegen into packages/proto/src/gen (required before first typecheck)
pnpm dev:stack:mock   # mock-salus + bridge + web — fully offline
pnpm dev:stack        # bridge + web against a running Salus fleet
pnpm test             # vitest across packages and apps — the single test tier
pnpm lint && pnpm typecheck && pnpm build
```

- **Never run dev servers (`pnpm dev*`) as foreground agent commands** — they don't exit. Use a background task or a real terminal.
- Proto vendoring: `pnpm sync-protos` copies `../salus/src/proto/Salus/*.proto` into `packages/proto/vendor/salus/` and pins the source commit in `packages/proto/salus-commit.lock`; `pnpm sync-protos:check` is the CI drift gate; `buf breaking` against the committed baseline image is the wire-compat gate.

## Testing

One tier: `pnpm test` runs vitest across every package and app. `mock-salus` serves a deterministic double of every service the console consumes, so the entire app runs offline and the same code connects to the real fleet unchanged. Browser-only behaviours are verified manually against `pnpm dev:stack:mock`.

## Git Workflow

- Main branch: `main`
- Feature branches: `dev-<feature>` or `feature/<description>` or `fix/<description>`
- **Commit subject style.** A commit either *ships versioned product work* or it doesn't, and the subject says which:
  - **Versioned** (bumps the root `package.json` `"version"` — the single source of truth): `vX.Y.Z Short description` — e.g. `v0.1.3 Bridge Connect forward + read-only guard`.
  - **Non-versioned** (anything that does NOT bump the version — infra, tests, docs, tooling, config): a **`type:` prefix** — one of `docs:` · `proto:` (vendored-proto sync / codegen refresh) · `test:` · `infra:` (CI, bridge deployment) · `chore:` (Claude Code config, settings, dev tooling) · `fix:`. Pick the closest; don't invent new types casually.
  - Never leave a non-versioned commit prefix-less.
- **Do NOT add `Co-Authored-By` or any contributor-attribution lines to commit messages.**
- **The `zeno` / `zeno-gui` projects are freely-usable sources, but must never be *named* in this repository.** You may read the local `zeno-gui` repo and copy/port its code, architecture, and ideas at will — it is the reference implementation this console's plans mirror. The single hard rule is textual: those project names (or their paths, package scopes, or any identifying reference) must **never appear in committed salus-gui text** — not in code, comments, commit messages, docs, plans, or lockfiles' prose. When you port something, re-express it fully in Salus terms (rename scopes, symbols, and comments; describe the design without naming its origin). Copy the substance freely; launder the name completely.
- **Add a row to [docs/commit-history.md](docs/commit-history.md)** under the current version table for every versioned commit — the human-readable version log.
- **Update affected docs** — CLAUDE.md tables when the architecture changes; the `README.md` beside any app/package that gained or lost surface.
- **Be terse.** A commit-history row targets ≤ 80 words and a commit body under ~30 lines. Lead with the *what* and the *why*; skip file enumeration — the diff has it. Long expository prose belongs in the plan.

### Minor / major release tag (`vX.Y.0`)

When a development series wraps, keep `main`'s history linear (no merge commits):

1. **Bump version** in the root `package.json` (`x.y.(z+n)` → `x.(y+1).0` for a minor; `(x+1).0.0` for a major).
2. **Update [docs/commit-history.md](docs/commit-history.md)** so the series' prose captures everything shipped.
3. **Commit subject**: `vX.Y.0 Release — <comma-separated capability themes>` (one line).
4. **Fast-forward main**: `git checkout main && git merge --ff-only <dev-branch> && git push origin main`.
5. **Annotated tag**: `git tag -a vX.Y.0 -m "vX.Y.0 — <themes>" <sha>` then push the tag.

Verification: `git log --oneline --first-parent main` reads as one continuous version chain with no `Merge …` entries.

## Plans Lifecycle

All planning documents live in [docs/plans/](docs/plans/); the canonical state of every plan is recorded in [docs/plans/INDEX.md](docs/plans/INDEX.md). Each plan is **queued** (written, not started), **in-progress** (work begun — listed under `## Active Plans` below), **parked** (started but paused — INDEX row annotated with the resume condition), or **complete** (shipped — stays in `docs/plans/` as a historical record, removed from CLAUDE.md, affected `docs/*.md` updated).

**Reference rule:** the `## Active Plans` section below lists only plans whose state is `queued` or `in-progress` — a completed plan is removed from it on completion. Elsewhere in this file a completed plan may still be cited as the design record for the thing it produced; those citations are documentation, not lifecycle state.

### Lifecycle rituals (the agent must follow these)

- **New plan (cold start):** write `docs/plans/<name>.md`; add a `queued` row to [docs/plans/INDEX.md](docs/plans/INDEX.md). No CLAUDE.md change yet.
- **Start work (`queued → in-progress`):** bump the INDEX row to `in-progress` + fill `Started`; add a one-line entry under `## Active Plans`.
- **Complete (`in-progress → complete`):** bump the INDEX row to `complete` + fill `Completed` + list the architecture docs touched; edit the affected `docs/*.md`; remove the `## Active Plans` entry. The plan file stays (historical record).

### Active Plans

- [salus-gui-repo.md](docs/plans/salus-gui-repo.md) — **queued.** The `v0.1.x` scaffold train: pnpm workspace + toolchain, the proto vendoring pipeline (`sync-protos` + commit lock + buf codegen + breaking gate), `@salus-gui/{proto,streams,theme,ui-kit,mock-salus}`, the bridge (`:56400` — Connect⇄gRPC forward, read-only guard, audit, `/kv`), the SPA shell with a first live fleet-status panel, and CI. Releases as `v0.2.0`.
- [harness-control-gui.md](docs/plans/harness-control-gui.md) — **queued**, opens when the scaffold train releases. The `v0.2.x` control-surface train: fleet observability (Admin/Network status, seq-resumable logs, lifecycle), infra lifecycle control, the **regression-harness console** (run `test/run_all.py` suites from the GUI, stream and structure their output), the manually-driven **end-to-end platform session** (full fleet + Edge `--application-control`, driven step-by-step from the GUI), then the experimentation surfaces (session ejection, protocol operations, health/therapy observation, device-plane simulation). Releases as `v0.3.0`.

## Permissions & Tooling (agent)

[.claude/settings.json](.claude/settings.json) allowlists the commands this workflow needs. **Allowlisted**: `git` (incl. push/tag/merge), `node`/`corepack`/`pnpm`/`npm`/`npx`, `curl`/`jq`/`rg`/`grep`/`find`, `gh`, file plumbing (`mkdir`/`cp`/`mv`/`touch`/`chmod`), `lsof`/`kill` (reaping orphaned dev processes), and the repo helpers `./scripts/*` + `./tools/*`. **Gated** (`ask`): `git reset --hard`, `git clean`. **Denied**: `rm -rf`, `git push --force`.

The `attribution` block is set to empty (`commit: ""`, `pr: ""`) — it enforces the **no `Co-Authored-By`** rule above mechanically.

To avoid needless permission stops: keep each Bash call a single simple command; use the Edit/Write tools rather than `sed -i`; avoid `sh -c` wrappers; prefer the Read tool over `cat` for inspecting a known file. If a genuinely-needed command is missing from the allowlist, propose adding it rather than working around it.
