# salus-gui — agent instructions

**Read this as rules and pointers, not as reference.** Everything here is loaded into every session before I see your request, so it holds only what changes what I _do_. What each package, app and panel _is_ lives in the README beside its code; _why_ it is that way lives in [docs/plans/](docs/plans/) and [docs/commit-history.md](docs/commit-history.md). Getting it running is [docs/dev-setup.md](docs/dev-setup.md).

- **Stack**: TypeScript, SvelteKit 2 + Svelte 5 (runes), Connect (connect-es) ⇄ gRPC, buf + protoc-gen-es codegen, pnpm workspaces, vitest, Node ≥ 22.
- **Purpose**: the web operations console for the **Salus** platform — a dashboard for running the regression-test harness, operational control of the service fleet, and simulation/experimentation against the Edge application and the services. Built first as a development/test instrument, it carries forward as the operations-management console once the Salus platform is deployed.
- **Backend**: the sibling repo at `../salus` (C++17, gRPC, six services + the Edge client, an Envoy edge, a Python test harness). This repo never links against it — it vendors its protos at a pinned commit and speaks to it over the wire.

## Repository map

| Path                     | What is there                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`                  | reference for **built state** only — see [docs/README.md](docs/README.md)                                                                                       |
| `docs/plans/`            | the work lifecycle: `backlog/` → `NNN-*.md` → `completed/`; register in [INDEX.md](docs/plans/INDEX.md)                                                         |
| `docs/commit-history.md` | the release ledger                                                                                                                                              |
| `research/`              | open questions, not committed to — see [research/README.md](research/README.md)                                                                                 |
| `design/`                | intent reference — the design mocks a plan executes against; not built state — see [design/harness-control-gui/README.md](design/harness-control-gui/README.md) |
| `tools/`                 | repo tooling (`plans.py`, `check-plans.py` — stdlib-only Python; `sync-protos.ts`)                                                                              |
| `.claude/`               | agent settings, hooks and commands                                                                                                                              |
| `packages/`, `apps/`     | the pnpm workspace — five packages, two apps, each carrying its own README                                                                                      |

## Architecture

The browser talks to exactly one process — the **bridge** (`salus-bridged`, `:56400`) — over one h2/TLS connection:

| Browser wants                   | Bridge path                      | Backing surface                         | State    |
| ------------------------------- | -------------------------------- | --------------------------------------- | -------- |
| Unary + server-stream RPC       | `/rpc` Connect ⇄ gRPC forward    | the Salus gRPC service fleet            | built    |
| Named workspaces, saved views   | `/kv` file-backed document store | bridge-local state                      | built    |
| Audit log, read-only mode       | `/bridge/*` control endpoints    | bridge-local state                      | built    |
| Stack lifecycle (envoy, db)     | `/infra` control endpoints       | `../salus/infra/*/{up,down,status}.sh`  | `v0.2.2` |
| Suite runs, live harness output | `/harness` runner endpoints      | `../salus/test/run_all.py` subprocesses | `v0.2.3` |

Two planes, deliberately distinct:

- **Operator plane (default)**: the bridge dials services _directly_ over h2c — the private surfaces (Admin on every Component, Network fan-out, Health/Therapy query + subscribe, Protocol operator RPCs) are deliberately not Envoy-routed, and the console is an operator-plane client.
- **Device plane (simulation)**: the JWT + ext_authz path through the Envoy edge (`:58000`) is exercised _explicitly_ in the simulation panels — authenticate as a client, drive the edge-routed surface, observe ejection — never as the console's own transport.

Client/bidi-streaming RPCs (`StreamHealth`, `StreamTherapy` — the Edge's ingest sessions) are never forwarded to the browser; the console observes their effects through the query/subscribe surfaces.

### Workspace layout

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

| Service           | Port         | Console-relevant surface                                                                                                                                                              |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network           | 57000        | Registry + fleet fan-out (`GetRegistryStatus`, `GetAllStatus`, `GetAllMetrics`, `DrainAll`, `ShutdownAll`), aggregated `StreamLogs` / `StreamLifecycleEvents` / `StreamSuiteSnapshot` |
| Authentication    | 57010        | `Authenticate` / `Validate`; JWKS on HTTP 57011                                                                                                                                       |
| Session           | 57020        | Session roster + **`EjectSession`** (the live-control primitive), edge bindings, device presence; ext_authz on HTTP 57021                                                             |
| Health            | 57030        | `QueryHealthSamples` / `QueryHealthSummaries` / `GetHealthStats`, `SubscribeHealthEvents`                                                                                             |
| Therapy           | 57040        | Active-therapy registry + subscribes, `QueryTherapyMetrics` / `QueryTherapySessions`, `ApplyReconciliationDecision`                                                                   |
| Protocol          | 57050        | Import / Validate / Publish / Allocate (operator), pull surface + `WatchAssignment`                                                                                                   |
| Edge (client)     | own `--port` | `Salus.EdgeApplication` loopback (`ListDueRoutines`, `StartRoutine`, `SkipRoutine`, `GetApplicationState`) when run `--application-control`; harness convention 58070                 |
| _every_ Component | its port     | `Salus.Admin.Admin` — `Ping`/`GetStatus`/`GetMetrics`/`Drain`/`Shutdown`/`SetTrace`/`SetDebug` + `StreamLogs` (seq-resumable)                                                         |

Infra: Envoy edge 58000 (admin 58009), Postgres 55432, ClickHouse 59000 native / 59123 HTTP. Console-side ports sit outside the Salus 57xxx/58xxx bands: bridge **56400**, mock hub **56800**.

## Build & Dev (once the scaffold plan lands)

```bash
corepack enable && pnpm install          # postinstall runs buf codegen — the tree typechecks after this
pnpm --filter @salus-gui/bridge cert     # once — the bridge refuses to start without TLS

./infra/up.sh                            # mock fleet + bridge (offline)   → infra/README.md
./infra/up.sh --live                     # bridge → a real Salus fleet
./infra/status.sh                        # console processes + platform ports
./infra/logs.sh bridge -f                # follow a component's log
./infra/down.sh                          # stop

pnpm gen              # regenerate packages/proto/src/gen by hand (it is NOT committed)
pnpm test             # vitest across packages and apps — the single test tier
pnpm lint && pnpm typecheck && pnpm check && pnpm build   # check = svelte-check
```

- **Use `./infra/up.sh` rather than `pnpm dev*` directly.** It detaches properly (a `pnpm dev*` child holding the caller's stdin hangs the invoking shell), records PIDs so `down.sh` can stop the _server_ rather than a fork of the script, checks the three prerequisites up front, and stops by PID tree — never by process group, which shares a group with the calling shell and takes it down too.
- **Never run dev servers (`pnpm dev*`, `vite`, `tsx watch`) as foreground agent commands** — they don't exit, so a foreground call hangs the turn. A `PreToolUse` hook in [.claude/settings.json](.claude/settings.json) **denies** the foreground form mechanically, including inside a subshell or after `&&`, and allows `./infra/up.sh`, `run_in_background`, and one-shot builds.
- **Chain gates with `&&`, and never pipe one.** `pnpm lint | tail` hands you the pipeline's exit code, not lint's. **`set -e` does not abort in the agent shell and `${PIPESTATUS[0]}` reads empty under zsh** — both were measured, and both report a failing gate as a pass. `&&` is the only chaining verified to stop on failure and propagate the code; to keep output short, redirect to a file and `tail` it after the `&&`. This is not hypothetical: `v0.1.6` was committed and pushed with a red `eslint` and a flaky test because a `set -e` gate script printed its own success banner after a gate had already failed. **A gate you did not watch fail is a gate you have not run.**
- Proto vendoring: `pnpm sync-protos` copies `../salus/src/proto/Salus/*.proto` into `packages/proto/vendor/salus/` and pins the source commit in `packages/proto/salus-commit.lock`; `pnpm sync-protos:check` is the CI drift gate; `buf breaking` against the committed baseline image is the wire-compat gate. **Generated output stays out of git, recorded state stays in it**: `src/gen/` is ignored and rebuilt, while `.buf-image-prev.binpb` is tracked — it is the previous proto image, not derivable from the tree, and losing it disarms the breaking gate.
- **`tsc -b` does not check `.svelte` script blocks** — `pnpm check` (svelte-check) is the gate that does, and it is a distinct CI step. A wrong proto field path inside a component is invisible to typecheck.

## Testing

One tier: `pnpm test` runs vitest across every package and app. `mock-salus` serves a deterministic double of every service the console consumes, so the entire app runs offline and the same code connects to the real fleet unchanged. Browser-only behaviours are verified manually against `pnpm dev:stack:mock`.

## Standing Rules

- **Measured ROI before architectural change.** No framework swaps, state-management libraries, grid/dock replacements or build-tool changes without a _measured_ problem. "Defer" and "don't bother" are valid recommendations.
- **A committed rule with no gate drifts silently.** Every convention gets a hook, a lint rule, or a drift test (the plans register has `tools/check-plans.py`; the no-attribution rule has the settings `attribution` block; the dev-server rule has the PreToolUse hook). When adding a rule, name its gate — or record explicitly that it has none yet, so the gap is a decision rather than an accident. **And check the gate against a violation**: the dev-server hook silently missed `(pnpm dev …)` in a subshell for two stages because nobody fed it one.

## Git Workflow

- Main branch: `main`
- Feature branches: `dev-<feature>` or `feature/<description>` or `fix/<description>`
- **Commit subject style.** A commit either _ships versioned product work_ or it doesn't, and the subject says which:
  - **Versioned** (bumps the root `package.json` `"version"` — the single source of truth): `vX.Y.Z Short description` — e.g. `v0.1.3 Bridge Connect forward + read-only guard`.
  - **Non-versioned** (anything that does NOT bump the version — infra, tests, docs, tooling, config): a **`type:` prefix** — one of `docs:` · `proto:` (vendored-proto sync / codegen refresh) · `test:` · `infra:` (CI, bridge deployment) · `chore:` (Claude Code config, settings, dev tooling) · `fix:`. Pick the closest; don't invent new types casually.
  - Never leave a non-versioned commit prefix-less.
- **Do NOT add `Co-Authored-By` or any contributor-attribution lines to commit messages.**
- **The `zeno` / `zeno-gui` projects are freely-usable sources, but must never be _named_ in this repository.** You may read the local `zeno-gui` repo and copy/port its code, architecture, and ideas at will — it is the reference implementation this console's plans mirror. The single hard rule is textual: those project names (or their paths, package scopes, or any identifying reference) must **never appear in committed salus-gui text** — not in code, comments, commit messages, docs, plans, or lockfiles' prose. When you port something, re-express it fully in Salus terms (rename scopes, symbols, and comments; describe the design without naming its origin). Copy the substance freely; launder the name completely.
- **Add a row to [docs/commit-history.md](docs/commit-history.md)** under the current version table for every versioned commit — the human-readable version log.
- **Update affected docs** — CLAUDE.md tables when the architecture changes; the `README.md` beside any app/package that gained or lost surface.
- **Be terse.** A commit-history row targets ≤ 80 words and a commit body under ~30 lines. Lead with the _what_ and the _why_; skip file enumeration — the diff has it. Long expository prose belongs in the plan.

### Minor / major release tag (`vX.Y.0`)

When a development series wraps, keep `main`'s history linear (no merge commits):

1. **Bump version** in the root `package.json` (`x.y.(z+n)` → `x.(y+1).0` for a minor; `(x+1).0.0` for a major).
2. **Update [docs/commit-history.md](docs/commit-history.md)** so the series' prose captures everything shipped.
3. **Commit subject**: `vX.Y.0 Release — <comma-separated capability themes>` (one line).
4. **Fast-forward main**: `git checkout main && git merge --ff-only <dev-branch> && git push origin main`.
5. **Annotated tag**: `git tag -a vX.Y.0 -m "vX.Y.0 — <themes>" <sha>` then push the tag.

Verification: `git log --oneline --first-parent main` reads as one continuous version chain with no `Merge …` entries.

## Plans Lifecycle

Plans live in [docs/plans/](docs/plans/); the register is [docs/plans/INDEX.md](docs/plans/INDEX.md). **A plan's state is its location**, and the governing invariant is **numbered ⟺ listed in INDEX**:

| State         | Where                                                          | Numbered?                   |
| ------------- | -------------------------------------------------------------- | --------------------------- |
| **backlog**   | `docs/plans/backlog/<name>.md`                                 | no — and no INDEX row       |
| **running**   | `docs/plans/NNN-<name>.md`                                     | yes, allocated at promotion |
| **parked**    | `docs/plans/NNN-<name>.md` — running work on hold, **no move** | yes                         |
| **completed** | `docs/plans/completed/NNN-<name>.md` — **same number**         | yes                         |

**Numbers are allocated at promotion, in the order work actually started, and are never reused or renumbered** — including at completion, which is precisely when a plan has accumulated the most inbound references. The backlog is deliberately unordered: ordering it would mean maintaining a sequence that promotion already produces for free.

**Reference rule:** this file only ever references plans in `backlog/` or currently running. What a completed plan shipped lives in [docs/commit-history.md](docs/commit-history.md) and in its own file under `docs/plans/completed/`.

### Rituals (the agent must follow these)

Every transition is **edit the INDEX row, then run the tool.** Never move a plan file by hand — inbound references accumulate across the tree, and `tools/plans.py sync` rewrites all of them (markdown link targets _and_ bare path strings) in the same pass. `tools/check-plans.py` is the lint that holds it all: register consistency both ways, the `**Status**:` line in every plan, backlog freshness, and every link into `docs/plans/` from anywhere.

- **New plan**: write `docs/plans/backlog/<name>.md` with `**Status**: backlog`; run `tools/plans.py render-index`. No number, no row, no change here.
- **backlog → running**: add an INDEX row under `## Running` with the next free number; `tools/plans.py sync`; set `**Status**: running`; add a one-line entry under Active Plans. **This is the rebase point** — check the plan against the current architecture before picking it up, so a plan that sat in the backlog is not executed stale.
- **running → completed**: move the row to `## Completed` (the number does not change); `tools/plans.py sync`; set `**Status**: completed`; edit the affected `docs/*.md` to the shipped state; remove the Active Plans entry. **Never delete the plan file.**
- **running → parked**: move the row to `## Parked` only — no file moves; set `**Status**: parked`. A plan that never started is not parked — it belongs in the backlog, unnumbered.

The full ritual, step by step, is in [docs/plans/INDEX.md](docs/plans/INDEX.md#how-to-update-this-file).

### Where a document belongs

`docs/` is **reference for built state only** — the test is _is it built?_ A plan is a stage ladder and goes to `docs/plans/backlog/`; an open question goes to [research/](research/) and is promoted into the backlog when it resolves into something worth building. Mixed documents leave `docs/`: a file that is partly forward-looking splits, the shipped-state half staying and the proposal half becoming a backlog plan or a research note.

A **design mock** — the intended look and behaviour of a surface a plan will build — goes to `design/<plan-name>/`, referenced from the plan's `## Design reference`; when the plan completes, what shipped is described in `docs/`, and the mock stays as the record of intent. `design/` is exempt from lint and prettier (see [.prettierignore](.prettierignore) and [eslint.config.js](eslint.config.js)): a mock is a reference artifact, and its runtime is generated output from another toolchain.

### Active Plans

**Nothing running.** The `v0.1.x` scaffold train released as `v0.2.0` on 2026-09-08 and its plan is completed; the console runs, offline against the mock or `--live` against a real fleet.

Next up, unpromoted: [harness-control-gui.md](docs/plans/backlog/harness-control-gui.md) — the `v0.2.x` control-surface train (fleet observability, infra lifecycle control, the **regression-harness console**, the manually-driven **end-to-end platform session**, then the experimentation surfaces); releases as `v0.3.0`. Its operator surface is specified in [design/harness-control-gui/README.md](design/harness-control-gui/README.md). **Promotion is the rebase point**, and for this plan it carries one extra step: walk the design README's §7 _Deviations_, decide each, and record the decision there before allocating the number.

## Permissions & Tooling (agent)

[.claude/settings.json](.claude/settings.json) allowlists the commands this workflow needs. **Allowlisted**: `git` (incl. tag/merge), `node`/`corepack`/`pnpm`/`npm`/`npx`, `python3` (the stdlib-only plans tooling), `curl`/`jq`/`rg`/`grep`/`find`, `gh`, file plumbing (`mkdir`/`cp`/`mv`/`touch`/`chmod`), `lsof`/`kill` (reaping orphaned dev processes), and the repo helpers `./scripts/*` + `./tools/*` (`tools/plans.py`, `tools/check-plans.py`). **Gated** (`ask`): `git push`, `git reset --hard`, `git clean`. **Denied**: `rm -rf`, `git push --force`, and foreground dev servers via the `PreToolUse` hook (Build & Dev above). The `autoMode.allow` block documents, entry by entry, why each command family is safe to run unprompted.

The `attribution` block is set to empty (`commit: ""`, `pr: ""`) — it enforces the **no `Co-Authored-By`** rule above mechanically.

To avoid needless permission stops: keep each Bash call a single simple command; use the Edit/Write tools rather than `sed -i`; avoid `sh -c` wrappers; prefer the Read tool over `cat` for inspecting a known file. If a genuinely-needed command is missing from the allowlist, propose adding it rather than working around it.
