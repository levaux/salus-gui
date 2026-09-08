# Harness & control GUI — gRPC surfaces, the regression console, and experimentation (`v0.2.x` → released `v0.3.0`)

Turns the walking skeleton of [salus-gui-repo.md](salus-gui-repo.md) into the working instrument:
GUI elements over the Salus gRPC surfaces, a **regression-harness console** that runs
`../salus/test/run_all.py` from the browser, and — the milestone this plan is built around — the
**end-to-end platform session run manually from the GUI with automated elements** (preflight,
readiness gates, teardown), before broadening into the experimentation surfaces. Opens when the
scaffold train releases `v0.2.0`; depends on nothing else.

## Ground truth this plan builds on (verified against the Salus tree)

- **The harness.** `test/run_all.py` sweeps a declarative registry of **31 suites**, each in its
  own subprocess; `--only <key>` / `--skip <key>` select (keys are lowercase: `harness`,
  `component`, `auth`, `bench`, `records`, `protocolstore`, `edgecontrolstore`,
  `protocolservice`, `edgesync`, `edgeapp`, `vault`, `streamprobe`, `healthstream`,
  `healthledger`, `healthquery`, `healthstress`, `delivery`, `protocol`, `protocolunit`,
  `healthunit`, `therapyunit`, `therapydevice`, `therapycoordinator`, `therapystream`,
  `therapyledger`, `edgeintegration`, `edgesmoke`, `deliverymodel`, `identityreconciliation`,
  `fleetresilience`, `data`). `--plain` disables TTY redraw — linear output, right for piping.
  Exit 0 iff every *ran* suite passed; infra-gated suites **skip** (never fail) when their probe
  (Envoy 58000 / Postgres 55432 / ClickHouse 59000) is down, and a pre-flight table says which.
- **The output grammar** is line-based and stable: C++ `[test]` wire lines
  (`[test] <name> PASS|FAIL[ | detail]`), Python `CheckList` glyph lines (`✓` / `✗` / `⊘` +
  counts footer), framed suite banners (`▶` open, `✓`/`✗` close with `n/31` + elapsed, `⊘ SKIP`),
  and the master summary. Machine-readable artifacts (`summary.json` + `junit.xml` via
  `Artifacts.finish()`) exist but only 4 of 31 suites emit them today.
- **The fullest end-to-end flow** is `test/EdgeApp/run_test.py`: Postgres + Envoy up; Session
  (57020, `--authz-http-port 57021`), Authentication (57010, `--signing-key
  infra/envoy/keys/jwt-test.key`, `--jwks-http-port 57011`), Protocol (57050, `--records-dsn`);
  then `bin/edge --port 58070 --application-control --vault-path … --protocol-sync
  --auth-secret …` — readiness marker on stdout: **`Application control ready.`** — and drives
  `Salus.EdgeApplication` on `localhost:58070`: `ListDueRoutines → StartRoutine → idempotent
  retry → SkipRoutine → GetApplicationState`, cross-checked against sqlite (vault) and Postgres.
- **The live-control primitive** is `Session.EjectSession` (direct, 57020): the next edge call
  fails at ext_authz even though the JWT still verifies. The edge exposes exactly 11 routes;
  everything operator-grade is deliberately not edge-routed.
- **Every Component serves `Salus.Admin.Admin`** on its own port — Edge processes included — so
  the `admin` catalog entry + `salus-admin-target` header reaches anything, and
  `Admin.StreamLogs` / `Network.StreamLogs` / `StreamLifecycleEvents` / `StreamSuiteSnapshot`
  are seq-resumable structured feeds, ANSI-free by contract.

## Guardrails (hold for every stage)

- **Everything mutating is `MUTATING_RPCS`-listed, read-only-guardable, and audited** — and the
  bridge-local surfaces this plan adds (`/harness` run spawner, `/infra` lifecycle, the session
  orchestrator) honour the same read-only switch: one flip makes the whole console observe-only.
- **The console never reads a database directly.** Health/Therapy data comes through their query
  RPCs; ClickHouse's open HTTP port is not a data path (mirror of the platform rule that the
  owning service fronts its store).
- **Subprocess authority is explicit.** The bridge spawns only two things — `test/run_all.py`
  and the session orchestrator's declared process plan — under a configured `SALUS_REPO` root,
  bound to loopback, with run records (NDJSON) for everything started, and orphan reaping on
  bridge shutdown.

## Staged path

### v0.2.1 — Fleet observability panels
The Operate module: service grid (Network registry + `GetAllStatus`/`GetAllMetrics`, conflated),
per-service Admin drawer (`Ping`/`GetStatus`/`GetMetrics`/`GetConfig(redacted)`,
`SetTrace`/`SetDebug`, `Drain` — mutators gated), the aggregated log console
(`Network.StreamLogs`, seq resume, level/label filters) and lifecycle feed, per-process
`Admin.StreamLogs` via `salus-admin-target`. Proves the dock + grid + log components at real
stream rates; mock scenarios for disconnect/resume.

### v0.2.2 — Infra lifecycle control
Bridge `/infra` surface: structured status (bridge-side TCP probes of 58000/58009/55432/59000/
59123 + Envoy admin `/ready` proxy) and lifecycle actions shelling
`../salus/infra/{envoy,db}/{up,down,status}.sh` with streamed output. GUI stack panel: one row
per stack, states, up/down buttons (audited; refused in read-only mode). This is the "some
automated elements" substrate — the harness console's preflight reuses it.

### v0.2.3 — The regression-harness console
Bridge `/harness` surface: a **typed suite catalog** (the 31 keys + display names + descriptions
+ infra gating, with a vitest **drift gate** that parses `test/run_all.py`'s registry and fails
when the catalog and the registry disagree); a run spawner (`python3 test/run_all.py --plain
[--only k]…`, forwarded flags whitelisted: `--skip`, `--verbose`, `--diag-level`,
`--warn-as-error`, `--no-speed`, `--iterations`); live stdout streamed to the browser; a **line
classifier** turning the output grammar into a structured run model (suite open/close/skip,
check rows with pass/fail/detail, counts, elapsed, master verdict from exit code) — classifier
fixtures are **recorded transcripts of real runs**, committed, so grammar drift is a red test,
not a silent mis-render; run history (NDJSON + rerun-with-same-selection); artifact ingestion
(`summary.json`/`junit.xml`) where a suite emits them. GUI: suite picker with infra badges,
preflight card (probes + one-click `/infra` bring-up of whatever the selection needs), live run
view, history. **This stage is the first deliverable of the repo's purpose: the full regression
matrix launched, watched, and dispositioned from the dashboard.**

### v0.2.4 — The end-to-end platform session (manual, with automated elements)
A bridge **session orchestrator** generalizing the EdgeApp flow into a declared process plan:
preflight (db + envoy via `/infra`) → seed credentials → Session / Authentication / Protocol
(later + Health/Therapy/Network) from `../salus/bin` with the harness's flags → `bin/edge
--application-control --protocol-sync --vault-path …` (readiness gated on
`Application control ready.`) → teardown in reverse, orphan-safe. Each process: state, port,
live log tail. The GUI session panel is **operator-paced**: bring-up, protocol allocate/sync,
then the `EdgeApplication` loop — `ListDueRoutines` → `StartRoutine` (disposition + step
outcomes rendered) → `SkipRoutine` → `GetApplicationState` — each a button, with the automated
elements between (readiness gates, status refresh, log correlation). The `edgeapplication`
catalog entry's dynamic target binds to the session's Edge port. This is the manual end-to-end
harness run the console exists to host; a one-click "scripted walk" of the same steps is the
automation follow-on, not the point.

### v0.2.5 — Experimentation: control surfaces
Session panel (roster/detail, edge bindings, presence; **EjectSession** with the observable
consequence — the panel invites re-driving the device plane to watch the denial); Protocol
operations (Import → Validate (findings with stable field paths rendered) → Publish → Allocate
pipeline + `WatchAssignment` live view); the **token workbench**: `Authenticate` through the
Envoy edge (`:58000` — the bridge forwards it as just another catalog target; `Authorization`
crosses verbatim), decode/inspect claims, then **act-as-client** — drive the 11 edge routes with
the minted token to exercise JWT + ext_authz end to end, including post-ejection refusal.

### v0.2.6 — Experimentation: data-plane observation
Health: `SubscribeHealthEvents` live feed + `QueryHealthSamples`/`QueryHealthSummaries` (bounded,
subject-scoped) + `GetHealthStats`; Therapy: active-therapy registry (`SubscribeActiveTherapies`)
+ committed-event feed + `QueryTherapyMetrics`/`QueryTherapySessions`; uPlot series views over
the query results. Paired with a running `EdgeSmoke`/`EdgeIntegration`-style session this closes
the loop: drive the Edge from one panel, watch its telemetry commit in another.

### v0.3.0 — Release
`v0.3.0 Release — fleet ops, regression console, end-to-end session, experimentation surfaces`.
`docs/` gains the harness-integration reference (suite catalog, output grammar, orchestrator
plan format); commit-history v0.2 series prose finalized.

## Verification

- Mock-first per stage (mock scenarios + recorded-transcript fixtures keep vitest hermetic);
  then against the real repo: `--only harness component` from the GUI matches a terminal run
  line-for-line in verdict; the v0.2.4 session panel completes the EdgeApp loop with the same
  dispositions `test/EdgeApp/run_test.py` asserts; eject-then-denied observed via the token
  workbench.
- The read-only switch, flipped mid-session, refuses the next mutator of *every* kind (RPC,
  infra action, harness run, session step) — one vitest contract per surface.

## Risks / gotchas

- **Output-grammar coupling.** The classifier rides on the harness's human-readable lines; the
  committed-transcript fixtures make drift visible, and the durable fix is upstream — extend
  `Artifacts.finish()` coverage beyond the current 4 suites (a Salus-side follow-up this plan
  records but does not own).
- **Long runs vs. browser lifetime.** Runs belong to the bridge, not the tab: closing the
  browser must not kill a sweep; reattach comes from run history. Conversely bridge shutdown
  must reap children — both directions tested.
- **The suite registry will grow** (31 today). The drift gate turns a new Salus suite into a red
  console test — additive fix, one catalog row.
- **Path coupling to `../salus`** (`SALUS_REPO` env override) — the bridge degrades gracefully
  to pure-RPC mode when the repo (or Python venv bootstrap) is absent: panels stay, `/harness`
  and the orchestrator report unavailable.
- **Envoy config is static** — `up.sh` won't reload a running container; the `/infra` surface
  must expose down+up as the restart, not assume reload.
- **Never widen the bridge into a shell.** Only the two declared spawn surfaces; no arbitrary
  command endpoint, ever.
