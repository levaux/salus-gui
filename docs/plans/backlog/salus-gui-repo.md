# salus-gui repo — the workspace scaffold (`v0.1.x` → released `v0.2.0`)

**Status**: backlog

Creates the salus-gui codebase: a pnpm monorepo carrying a SvelteKit 2 + Svelte 5 SPA and a
TypeScript bridge process, speaking natively to the Salus gRPC fleet. The architecture is ported
from the proven reference console for the parent trading platform (per the naming rule in
CLAUDE.md → Git Workflow, that project is never named in this repository; its local checkout is
the porting source). This plan ends with a **walking skeleton**: every layer present, CI green on
a fresh checkout, and one genuinely live panel — fleet status + aggregated logs — working against
both the deterministic mock and a real running Salus fleet.

## Architecture decisions (fixed by this plan)

1. **One TypeScript bridge, not a gRPC-web filter on the Salus Envoy.** The browser talks to
   exactly one process — `salus-bridged` (`:56400`) — over one h2/TLS connection (browsers only
   multiplex h2 over TLS; a workspace's many live streams would starve the ~6 HTTP/1.1
   connections per origin). The bridge terminates TLS (mkcert LAN cert,
   `SETTINGS_MAX_CONCURRENT_STREAMS ≥ 256`), forwards Connect ⇄ gRPC generically, owns the
   read-only guard + audit log, serves `/kv` and the built SPA. The Salus Envoy (`:58000`) today
   has **no gRPC-web, no CORS** — and adding them would put the console on the device plane; the
   operator surfaces (Admin, Network fan-out, Health/Therapy query, Protocol operator RPCs) are
   deliberately not edge-routed. The escape hatch stays: `makeTransport()` takes
   `protocol: 'connect' | 'grpc-web'`, a one-line config change if a proxy ever fronts the fleet.
   Record as `docs/adr/001-bridge-vs-edge-proxy.md`.
2. **Two planes.** The bridge dials services directly over h2c (operator plane). The JWT +
   ext_authz Envoy path is exercised only *deliberately*, by the simulation panels of the next
   plan — never as the console's own transport.
3. **Vendored protos at a pinned commit — not a submodule.** `tools/sync-protos.ts` copies
   `../salus/src/proto/Salus/*.proto` (all 10, `EdgeControl.proto` included even though it has no
   service yet — its messages are the `v0.8.x` contract surface; `Test/` protos excluded — the
   console drives the harness by running it, not by speaking its probe protos) into
   `packages/proto/vendor/salus/`, recording source SHA + per-file sha256 in
   `packages/proto/salus-commit.lock`. Codegen is **buf v2 + protoc-gen-es v2** (`target=ts`).
   Record as `docs/adr/002-proto-vendoring.md`.

   **Generated output stays out of git; recorded state stays in it.** `packages/proto/src/gen/`
   is gitignored and rebuilt by `pnpm gen`, wired to the proto package's **`postinstall`** so a
   fresh checkout typechecks after a plain `pnpm install` with no extra step. The generated code
   is then fully determined by pinned inputs — the drift-gated vendored sources plus the pinned
   buf toolchain — so there is nothing to diff and **no regenerate-and-diff CI gate**: `pnpm gen`
   runs before typecheck and everything after depends on it. The distinction that decides what
   may be ignored: `.buf-image-prev.binpb`, the wire-compat baseline, **stays tracked** — it is
   *recorded state* (the previous proto image), not derivable from the current tree, and deleting
   it would silently disarm the breaking gate. Two CI gates remain: `sync-protos:check`
   (unintentional drift, needs no Salus checkout) and `buf breaking` against that baseline
   (intentional-but-incompatible bumps forced through review).
4. **Streaming shapes.** The browser consumes unary + server-stream only. Client/bidi-stream RPCs
   (`StreamHealth`, `StreamTherapy` — the Edge's acknowledged ingest sessions) are never
   forwarded; the console observes their effects through the query/subscribe surfaces.
5. **Console ports sit outside the Salus bands** (57xxx services, 58xxx test processes):
   bridge **56400**, mock hub **56800**. The mock's single hub answers the whole catalog via a
   `portBase` rebase (`port = portBase + (catalogPort − 57000)`).
6. **Single test tier — plus `svelte-check`, which is not the same gate.** vitest across every
   package and app, `environment: 'node'`, colocated `src/**/*.test.ts`. No browser-automation
   tier; browser-only behaviour is verified manually against the mock stack. But **`tsc -b` does
   not check the script blocks inside `.svelte` files**, and that blind spot is not theoretical:
   upstream shipped two live bugs through it, one a wrong proto field path that silently produced
   no data. A console whose panels are mostly proto field paths cannot leave that ungated, so
   `pnpm check` (svelte-check) is a distinct CI step after typecheck.
   Async tests **await real completion, never a sleep** — a fixed `setTimeout` before an
   assertion passes locally and flakes on a slow runner; have the fake resolve a promise when the
   handler actually finishes.
7. **Versioning.** The root `package.json` `"version"` is the single source of truth from
   `v0.1.1` on; every stage below is one versioned commit + a `docs/commit-history.md` row.

## Staged path

### v0.1.1 — Workspace + toolchain + CI skeleton
pnpm workspace (`packages/*`, `apps/*`), root `package.json` (private, `type: module`,
`packageManager: pnpm@9.x`, `engines.node >= 22`, the script surface: `dev`, `dev:bridge`,
`dev:mock`, `dev:stack`, `dev:stack:mock`, `build`, `gen`, `sync-protos[:check]`, `typecheck`,
`test`, `lint`, `format`), `.nvmrc` = 22, `tsconfig.base.json` (ES2022, `moduleResolution:
bundler`, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
`verbatimModuleSyntax`, `composite`, `paths` for `@salus-gui/*` → package `src/index.ts`), root
solution `tsconfig.json` (project references; `apps/web` deliberately excluded — `svelte-check`
owns it), eslint flat config (typescript-eslint + svelte; `no-console` error everywhere except
the bridge, which logs structured stdout), prettier + svelte plugin, `.github/workflows/ci.yml`
(corepack → pnpm cache → install → `tools/check-plans.py` (the plans-lint gate, stdlib-only so
it needs no install step) → lint → typecheck → **`pnpm check`** (svelte-check — decision 6);
later stages append their gates in front: the proto drift + codegen + breaking steps at v0.1.2,
`pnpm test` and `pnpm build` at v0.1.6). A follow-on for the lint itself: a vitest suite feeding
`check-plans.py --root` violating fixture trees, proving each register rule *fails* when broken.
Root scripts include `check` → `pnpm --filter @salus-gui/web check`.

### v0.1.2 — `@salus-gui/proto`: vendoring pipeline + codegen + catalogs
`tools/sync-protos.ts` (source `../salus/src/proto/Salus`, `SALUS_PROTO_SRC` override; `sync` +
`--check` modes, pure `node:` builtins) + `salus-commit.lock`; `buf.yaml` (module root
`vendor/salus`, lint `STANDARD`, breaking `WIRE_JSON`) + `buf.gen.yaml` (protoc-gen-es,
`target=ts`, `src/gen` gitignored + a `postinstall: buf generate` so a fresh checkout typechecks
after plain `pnpm install` — decision 3; no `gen:check` script, there is nothing committed to
diff); the **well-known choke point** (`well-known.ts`: Timestamp ↔
Date/µs helpers, `Decimal` accessors — an eslint `no-restricted-syntax` rule bans `.unscaled` /
`.scale` member access everywhere else); `services.ts` `SERVICE_CATALOG` — one line per service:
`network 57000`, `admin 57000` (re-targetable via a `salus-admin-target` header to any
Component's port, Edge processes included), `authentication 57010`, `session 57020`,
`health 57030`, `therapy 57040`, `protocol 57050`, `edgeapplication` (dynamic target — the Edge's
own `--port`, harness convention 58070); `mutating.ts` `MUTATING_RPCS` — a hand-curated
`Set<"Salus.Svc.Svc/Method">` seeded with `EjectSession`, `Drain`/`Shutdown`,
`DrainAll`/`ShutdownAll`/`Reset`, `SetTrace`/`SetDebug`, the Protocol operator writes
(`ImportProtocolArtifact`/`PublishProtocolRevision`/`AllocateProtocol`),
`ApplyReconciliationDecision`, and the EdgeApplication mutators (`StartRoutine`/`SkipRoutine`);
property tests (fast-check) on the choke point; the three proto gates wired into CI; baseline
`.buf-image-prev.binpb` committed.

### v0.1.3 — `@salus-gui/theme` + `@salus-gui/streams`
Theme: `tokens.css` (spacing/radius/type — UI face + monospace for all numbers, severity colors),
`light.css`/`dark.css`, `env-accent.css` (dev / staging / production accent — the console must
never let an operator mistake a production fleet for a dev one), `applyTheme()` writing
`data-theme`/`data-env` on `<html>`. Streams (framework-lean TS, no runes — reused by bridge and
tests): `makeTransport` (the only transport constructor; binary format for int64 fidelity,
unload-aborting fetch, fatal-vs-retryable Connect error classification), `StreamController`
(`idle → connecting → live → backoff → live|fatal`, jittered backoff, resume headers),
`ConflatedTable` (keyed keep-latest, ~16 ms flush, `applySnapshot` reconcile with eviction),
`bindResnapshot`, `RingBuffer`/`SeriesBuffer`, `ConnectionManager` (health probe +
mass-resubscribe). **Three** contracts are documented in the package README and pinned by vitest:
**SeqResume** (logs/lifecycle resume by `seq` via the `salus-log-since-seq` metadata convention),
**Resnapshot** (subscribe-then-snapshot ordering, no lost-update window), and **Linger** — store
acquisition is `acquire`/`release` refcounting where a released store stays alive for a linger
window (45 s default) instead of stopping at the last release; re-acquiring inside the window
cancels the pending stop and reuses the live streams. Navigating between panels therefore does
not tear down and re-snapshot every feed: an idle stream on the multiplexed h2 connection is
cheap, a re-snapshot is not. Pin the five cases — shared start, linger stop, reuse on quick
return, restart after a real stop, immediate stop at `lingerMs: 0`.

### v0.1.4 — `@salus-gui/mock-salus`: the deterministic fleet double
One h2c Connect hub on `:56800` answering the whole catalog (the bridge's `portBase` rebase
lands every service there). Doubles only what the console consumes: Admin (per-service status /
metrics / seq-numbered `StreamLogs`), Network (registry, `GetAllStatus`/`GetAllMetrics`,
aggregated logs + lifecycle + suite-snapshot streams), Session (roster + eject flips the row),
Health/Therapy (fixture-fed query + subscribe surfaces), Protocol (catalog + assignment pull +
`WatchAssignment` wake-ups). Deterministic: NDJSON fixtures + a virtual-clock `ScriptedStream`,
so vitest asserts exact frames. This is what makes the entire app runnable offline and the test
tier hermetic.

**The mock's world follows the request.** A double that ignores the request's window, subject or
filter — always answering "recent", always the same fixture set — makes the offline stack
*silently* disagree with the real fleet, and the disagreement surfaces as an empty panel nobody
can explain. Upstream hit exactly this three ways in one pass (a historical range answered with
bars ending at `now`, a run's configured date range ignored, a fixed symbol list answered for
any universe). So every generated answer is anchored to what was asked: a `QueryHealthSamples`
window returns samples that genuinely live in it, a subject-scoped query answers only that
subject, and an empty result is a real empty result. Locked with tests, per gap.

### v0.1.5 — `apps/bridge`: `salus-bridged` (`:56400`)
`node:http2` `createSecureServer` (mkcert cert from `apps/bridge/certs/`, refuses to start
without one; CI self-signs a throwaway), CORS for loopback dev origins, `/rpc` generic Connect ⇄
gRPC forward walking each catalog entry's method descriptors (unary + server-stream; client/bidi
skipped by rule — decision 4), request headers crossing **verbatim** (which is what makes seq
resume and, later, `Authorization` pass-through work with zero special-casing), one
`createGrpcTransport` per catalog entry resolved from `sites.json` (per-site host/portBase — the
dev site points at the mock hub), the read-only switch (mutating RPCs refused
`FAILED_PRECONDITION` fleet-wide at one flip), the audit log (ring + per-site NDJSON append),
`/kv` file-backed document store (named workspaces, saved views), `/bridge/info|audit|readonly`,
static serving of the built SPA in production.

**Client disconnect is routine stream lifecycle, not a fault.** The browser resets its h2 streams
on every reload, tab close, HMR update and sleep-wake — as `CANCEL` or `INTERNAL_ERROR`, and as
`protocol error: missing status` when the client vanished before trailers. Classify these
(`isClientDisconnect`: Connect `Canceled`, or `Internal`/`Aborted` whose raw message matches
that set) and log **one quiet line, no stack**; a reload resets every open stream at once, so
logging each as an error turns one reload into a hundred lines of noise and buries the real
faults. Everything else stays a logged error with its metadata scrubbed.

vitest: forward guard, header hygiene, KV round-trip, read-only refusal, disconnect
classification — the async ones awaiting real completion rather than a sleep (decision 6).

### v0.1.6 — `apps/web` + `@salus-gui/ui-kit` seed: the SPA shell + first live panel
SvelteKit SPA (`adapter-static`, `ssr = false`, fallback `index.html`), Vite dev proxy for
`/rpc`/`/kv`/`/bridge` → `https://localhost:56400` (and `VITE_RPC_ORIGIN` for the direct-h2
path), theme wiring, nav-rail shell + module registry, the singleton transport + connection
store (health probe = `Salus.Admin.Admin/Ping` against Network with a 3 s timeout), `clients.ts`
(one `createClient` per catalog service). ui-kit seed: status/badge primitives, a log-view
component, one grid wrapper (all blotters go through it — the swap seam for the grid library),
dock deferred to the next plan if the first panels don't need it. **The proving panel**: fleet
status (registry + per-service status/metrics, conflated) and the aggregated live log view
(`Network.StreamLogs` with seq resume) — the full path browser → bridge → fleet exercised
against mock and real. CI gains `pnpm test` + `pnpm build` (packages → web → bridge).

### v0.2.0 — Release
`v0.2.0 Release — workspace scaffold, proto pipeline, bridge, SPA shell` per the CLAUDE.md
release ritual (ff-only to main, annotated tag). `docs/dev-setup.md` written (Node/pnpm/mkcert,
codegen-before-first-typecheck, the three-terminal mock stack, pointing at a real fleet);
commit-history v0.1 series prose finalized.

## Verification

- CI green on a fresh checkout — and the fresh checkout is the point: `pnpm install` alone must
  leave a tree that typechecks, which is what the `postinstall` codegen buys and what CI proves
  by never running an extra step before `pnpm typecheck`.
- `pnpm dev:stack:mock`: fleet panel renders the mock registry; kill/restart the mock —
  the log view resumes with no gap (SeqResume) and status rows re-converge (Resnapshot).
  Navigate away from the fleet panel and back inside the linger window — the feeds are reused,
  not re-snapshotted (Linger); reload the page and the bridge logs one quiet disconnect line per
  stream, not a stack.
- Against the real repo: `../salus` built, `./infra/db/up.sh` + `./infra/envoy/up.sh`, Network +
  one more service running with `--register` — the same panel shows the live registry, and
  `salus-admin-target` reaches a second service's Admin surface through the one catalog entry.

## Risks / gotchas

- **Upstream proto drift discipline.** The lock pins a Salus SHA; a Salus proto change lands
  here only via `pnpm sync-protos` in one `proto:` commit, with `buf breaking` forcing review of
  incompatible bumps. Never hand-edit `vendor/`, and never commit `src/gen` — it is ignored, and
  a tracked copy would rot silently against the lock it is supposed to follow.
- **The services are h2c/insecure by design** (dev posture) — the bridge's `createGrpcTransport`
  uses plain `http://` baseUrls; TLS-to-fleet is a deployment-era concern, parked deliberately.
- **mkcert is a hard dev prerequisite** for the bridge; document it first in `dev-setup.md`
  (the failure mode — bridge exits at startup — must name the fix).
- **Do not let panels bypass the choke point**: all Timestamp/Decimal handling through
  `well-known.ts`; the lint rule is the gate.
- **`EdgeControl.proto` has no service** — codegen emits messages only; nothing may fabricate a
  client for it until the Salus `v0.8.6` service lands and a sync brings the surface in.
