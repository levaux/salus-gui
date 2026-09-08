# Design reference — Harness & control GUI

**What this is.** The intended operator surface for the `v0.2.x` control-surface train
([harness-control-gui.md](../../docs/plans/002-harness-control-gui.md)), as an HTML design
mock. It is **a design reference, not product code**: the console is recreated in the target
stack (SvelteKit 2 + Svelte 5 runes, `@salus-gui/ui-kit` dock/grid/status/log components,
`@salus-gui/theme` tokens, `@salus-gui/streams` for every feed) — never by shipping this HTML.

**Fidelity.** High-fidelity for layout, density, type, colour, copy, glyph vocabulary and
interaction model — recreate those. The **data is a 1 Hz mock** (registry, telemetry, logs,
suites, simulators are all synthesised in the page); the wire contracts to bind each element to
are listed under _Data contracts_. Where the mock predates the plan's ground truth it is the plan
that wins — see _Deviations to resolve at promotion_.

**Files.** `salus-control.dc.html` + `support.js` — open the HTML in a browser (same folder).
**It needs network**: `support.js` fetches React 18.3.1 from unpkg at boot and the fonts come
from Google Fonts, so offline the page renders blank rather than degrading. `⌘K` opens the
command palette. The
header's Envoy / Postgres / ClickHouse pills and the Simulate › Breakers panel are **chaos
toggles** in the mock: flip them to see every degraded state the design specifies.

---

## 1. Frame

One viewport, no page scroll. CSS grid rows: `header auto · Insights minmax(150px, Sfr) · 6px
divider · Workbench minmax(200px, (100−S)fr) · footer 28px`, `S` = split % (default 50, drag the
divider; persisted). Background `#0a0d11`; every pane `#0f1318`; 1px gutters `#222a34`.

**Header** (min-height 44px dense / 52px comfortable, `#0f1318`, bottom hairline): wordmark
`SALUS` (Plex Sans 600 15px, letter-spacing .22em, `#fff`) + `control · localhost` (mono 11px
`#5b6673`); five **summary pills** (22px tall, 1px `#222a34`, radius 3, mono 11px: glyph +
value + label — services `▶ 6/6 services`, sessions, denied, snapshot seq, harness state); three
**infra pills** (24px, `#141920`, radius 3: dot + name + port — Envoy :58000, Postgres :55432,
ClickHouse :59000); `⌘K` palette button; UTC clock (mono, right-aligned, min-width 90px); the
**ShutdownAll** kill switch (24px, `rgba(255,107,107,.45)` border, `rgba(255,107,107,.06)` fill,
red text) — armed confirm before it fires.

**Footer** (28px): left — snapshot state glyph (`⟳` green live / `⊘` yellow stale) + text
(`StreamSuiteSnapshot 1 Hz · updated 0.4s ago · 7 components` — **not** a seq; see §7.8, the
snapshot stream has none); right — `dense · insights 50% · ⌘K`.

**Density** is a root prop: `dense` `--fs:12px --fs-s:11px --row:26px --pad:10px --gap:8px`,
`comfortable` `13/12/34px/14px/12px`. Every row height, pad and gap in the design reads these.

## 2. Insights (top pane)

Grid columns `minmax(0,1fr) minmax(320px,27%)`: **Topology** | **Inspector**.

### 2.1 Topology

Pane header (row height, mono 11px 500): `─── Insights · Topology ───` · dim scheme note
`57xxx service · 58xxx edge/test · stores off-scheme` · right-aligned hint (`click a chip →
Inspector · …` / `<name> selected · Inspector →`).

One `<svg viewBox="0 0 1180 360">` scaled `xMidYMid meet` (width-bound at the half-height
split; nothing below it scrolls). 20px grid pattern stroked `#131820`. Links render under chips.

**Schematic** (all coordinates in viewBox units; chips 108 tall):

| Node | x,y | w | Role |
|---|---|---|---|
| Edge fleet | 6,126 | 150 | public plane — the Edge clients |
| Envoy | 172,126 | 156 | edge :58000, admin :58009 |
| Authentication · Session · Protocol | 346 / 556 / 766, y 6 | 194 | route row (Postgres-backed) |
| Postgres | 976,6 | 194 | :55432 `salus_records` |
| Health · Therapy | 346 / 556, y 246 | 194 | ingest row (ClickHouse-backed) |
| ClickHouse | 766,246 | 194 | :59000 `salus_data` |
| Network | 976,126 | 194 | hub :57000 — registry · heartbeat · logs · telemetry |

Links: Edge fleet → Envoy (`M156 180 H172`, label under the fleet chip `Bearer JWT · h2c`);
**route bus** `M328 180 H880` with label under it (`jwt_authn → ext_authz` / `ext_authz DENY ·
Session down` / `edge down — no route`); vertical connectors from the bus to each service chip's
centre (up to row 1, down to row 2); **telemetry link** `M880 180 H976` dotted, label above
(`telemetry` / `bus down`); **store buses** behind the rows — `M540 60 H976` (Postgres) and
`M540 300 H766` (ClickHouse), plain `#3b4756` 1.2px.

Link states: live `#3b4756`, 1.5px, `stroke-dasharray 6 6`, `@keyframes flow { to
{stroke-dashoffset:-24} }` 1s linear (telemetry link 1px, `2 5`, 1.6s); idle `#222a34` `2 4`;
broken `rgba(255,107,107,.55)` 1.2px `2 4`. A link is live only when both ends are up **and**
the route is allowed (Session down ⇒ every edge-routed link is broken except Session's own).

### 2.2 The service chip

Every node is the same **chip**; the status colour `S` drives the whole thing.

```
┌─┬────────────────────────────────────────────┐
│▌│ ● Authentication              [RUNNING]    │  head: dot · name · pill
│▌│ :57010 · JWKS :57011                       │  addr: port in cyan, rest dim
│▌│ UPTIME     SEEN        INFLT               │  3 stat columns (label/value)
│▌│ 1h 32m     3s ago      2                   │
│▌│ ─────────────────────────────────────────  │
│▌│ RPC/S           1.2/s   I/O        3.4 KB/s│  spark headers
│▌│ ╱╲╱‾╲__╱╲       ╱‾‾╲╱╲__╱                  │  two 14px sparklines
└─┴────────────────────────────────────────────┘
```

- Box 194×108 (Edge fleet 150, Envoy 156): `display:flex`, `overflow:hidden`, background
  `linear-gradient(180deg,#141920,#0f1318)`, border 1px `#222a34` (hover `#3b4756`), radius 7px,
  box-shadow `0 8px 24px -14px #000, inset 0 1px 0 rgba(255,255,255,.025), inset 0 0 0 1px S@16%,
  inset 0 0 30px -18px S`. **Selected**: `outline 1.5px solid S@70%; outline-offset 4px`.
- **Rail**: 3px, full height, background `S`, `box-shadow 0 0 12px -1px S`.
- Body padding `7px 9px 6px`. **Head**: 6px dot (`S`) with a pulse ring (`::after`-style child,
  `@keyframes beat {0%{scale 1;opacity .7} 70%,100%{scale 3.2;opacity 0}}` 1.6s ease-out
  infinite; `none` when the node is down); name Plex Sans 600 13px/1.1, −.01em, `#dde4ec`,
  ellipsis; **pill** mono 600 8px, .08em, `2px 4px`, radius 3, colour `S`, background `S@14%`,
  border 1px `S@32%`.
- **Addr** (margin-top 3): mono 400 9.5px/1.2 `#93a0ae`; the port token in cyan `#5fd7e0`.
- **Stats** (margin-top 6, gap 8, three equal columns): label mono 600 7.5px, .12em, uppercase,
  `#5b6673`; value mono 600 10.5px/1.2, `#dde4ec` (yellow/red when the value is the problem).
- **Sparks** (margin-top 6, top hairline `#1a2028`, padding-top 5): per column a label/value
  header (7.5px label · mono 500 9px value) over a 14px `<svg viewBox="0 0 100 14"
  preserveAspectRatio="none">` polyline, 1.2px, `vector-effect:non-scaling-stroke` — RPC/s in
  `S`, I/O in cyan. 32 samples at 1 Hz, auto-scaled to the window max; flat when nothing flows.
- **Footer variant** (stores, Edge fleet — no telemetry rows to plot): two mono 9.5px/1.2 lines
  in place of the sparks (`reachable · SalusRecords` / `← Auth · Session · Protocol`;
  `DOWN — ./infra/db/up.sh` in red).

Per-node content:

| Node | Pill | Stats | Sparks / footer |
|---|---|---|---|
| Service | registry status | `uptime` · `seen` (`3s ago`, `STALE` yellow when Network is down, `fail 2/3` red when stopped) · `inflt` | RPC/s = Σ inbound method rates · I/O = Σ bytes in+out |
| Network | registry status | `registry` n · `snapshot` seq (`STALE`) · `logs` seq (`12 held` yellow while disconnected) | its own rows |
| Envoy | `ALLOW` / `DENY ALL` / `DOWN` | `routes` (edge-routed methods) · `denied` (ext_authz denials, red when denying) · `jwks` `300s` | edge-routed traffic |
| Edge fleet | `LIVE` / `DENY` | sessions `live` · `denied` · `ejected` | footer: `Session-tracked plane` / `+20 synthetic edges` when the fleet sim runs |
| Postgres | `UP` / `DOWN` | `pool` · `writers` 3 · `errors` | footer |
| ClickHouse | `UP` / `DOWN` | `received` · `committed` · `held` (yellow when received > committed) | footer |

Status → `S`: RUNNING `#5be37a` · DRAINING `#f5c542` · DRAINED `#5b6673` · STARTING `#5fd7e0` ·
STOPPED / EVICTED `#ff6b6b`; infra UP green / DOWN red.

### 2.3 Inspector

Pane header `─── Inspector ───` with a `←` back control when a node is selected. Body scrolls.

- **Title row**: `●` in the node colour · name (Plex Sans 600 15px) · dim subtitle (mono).
- **Blurb**: 1–2 mono lines (`#93a0ae`, line-height 1.5) — the node's role from the catalog.
- **Facts**: two-column grid (`auto minmax(0,1fr)`, gap `2px 12px`, mono 11px): key `#5b6673`,
  value coloured by meaning (uptime, admin address, pid, heartbeat, fail count, in-flight,
  queue, trace/debug flags, store, sessions…).
- **Actions**: 22px buttons (1px `#222a34`, `#141920`, radius 2, mono 500) coloured by hazard —
  `◐ Drain` yellow, `■ Shutdown` red, `⟳ Trace on/off`, `⟳ Debug on/off`, `≡ Profile`,
  `⟲ Reset telemetry` grey — plus **Focus** (filters the Monitor panels to this component;
  toggles off). Destructive actions arm a confirm first.
- **Events**: the node's lifecycle events (`hh:mm:ss · ● type · service · msg`, type colour:
  started green · stopped grey · error red · reconnected cyan · draining yellow).
- **Sessions** (Session / Envoy / Edge fleet only): `● client · edge · heard Ns · status` with an
  18px red `eject` button per live row.
- **Logs**: that service's slice of the aggregated stream (`hh:mm:ss LVL message`, 10.5px).
- **Nothing selected** = platform overview: `Salus platform · localhost · levaux/salus@main`,
  facts (services running/draining/evicted, infra up n/3, sessions, harness state), actions
  `◐ DrainAll` · `■ ShutdownAll` · `⟲ Reset telemetry`, latest 6 lifecycle events.

## 3. Workbench (bottom pane)

**Tab bar** (min-height row, wraps): three tabs (26px, 12px pad, radius 3; active `#1a2028` /
`#dde4ec`, inactive transparent / `#93a0ae`) each with a live badge — Monitor `6/6`, Tests
`31` or `⠹ 3/7` while a sweep runs, Simulate `● fleet` — a 1px separator, then **panel chips**
(20px, mono 11px) for every panel in the tab (on: 1px `#2c3641` on `#1a2028`; off: dim text,
transparent), `drag ⋮⋮ to reorder · chips show/hide · saved locally`, and `reset layout`.

**Panel packing**: panels are `<section>`s in a `flex-wrap` row with 1px `#222a34` gutters
(the container's background). Each has a flex basis (below) and `flex-grow`; the design packs
them into rows by available width and gives every row an equal share of the workbench height —
**panels scroll internally, the workbench never does**. Header = drag handle `⋮⋮` (`#3d4652`) ·
`─── Title ───` · dim meta · controls · `×` (hide). Drag-over highlights the target; drop
reorders; order/hidden/split persist in `localStorage["salus-gui.v2.layout"]`.

| Tab | Panel | Basis | Content |
|---|---|---|---|
| Monitor | Registry | 300 | one row per service: spinner/glyph in status colour · name · `:port` · status tag (`▶ RUNNING` · `◐ DRAINING` · `○ DRAINED` · `◌ STARTING` · `■ STOPPED` · `✗ EVICTED`) · meta line (`seen 3s · fail 0 · rpc 2 · pid …`); Network shown as hub, not in its own registry |
| Monitor | SuiteSnapshot | 560 | telemetry table per component × method: kind (`U`/`SS`/`CS`/`BB`), dir, rate, bytes in/out, p50/p95/p99, calls, err, denied; ok-ratio bar; `stalled` rows (ClickHouse held) in yellow; **Focus** filter chip + `⟲ reset <component|all>` (Network.Reset); meta `seq · n components · n rows` or `Network unreachable — snapshot stale 12s` in yellow |
| Monitor | Logs | 400 | level chips `trc dbg inf wrn alm err ftl tst` (toggle; colours below) · `⏸ pause` / `▶ follow` · lines `hh:mm:ss.mmm LVL label message` (10.5px mono, level colour on LVL, error/fatal message coloured) · autoscroll unless paused; meta `n shown · seq` or `StreamLogs disconnected — n line(s) in producer rings, resume by seq` |
| Monitor | Lifecycle | 280 | `hh:mm:ss · ● type · service · msg` feed, seq badge |
| Monitor | Sessions | 280 | `● client · edge · since · key-timeout · heard · status` + `eject` |
| Tests | Suites | 520 | profile chips `all 31 · base · reliability · load`; sanitizer selector `release · -asan · -tsan · -ubsan`; flag chips; the **matrix**: `☐/☑` · glyph · name · description · profile tag · `needs E P C` infra badges (grey when the infra is down ⇒ suite will `⊘` skip) · last result (`✓ 4.2s` / `✗ 7.9s` / `⊘ reason` / `41% phase`) · `▶` run one; footer: command preview `$ ./test/run_all.py --only k …` · `▶ run selected (n)` · `▶ run all` · `■ stop` |
| Tests | Live | 400 | terminal-style pane (mono 11px/1.6): idle text with the command preview; running: framed banner `[▶ RUNNING] suite · desc`, `⠹ State [41%] ████░░░░: phase`, `─── Components ───` (spinner · name · `:port` · pid · status), `─── Diagnostics ───` (red), `─── Results ───` (`✓/✗ name detail`), footer `n passed, m failed`; close line `✓ suite · desc · 4.2s` |
| Tests | Artifacts | 320 | `path · kind · hh:mm:ss · copy` rows (`bin/log/<Suite>/log/artifacts/{junit.xml,summary.json}`), then `─── History ───` (`✓/✗/⊘ · suite · note · elapsed · sanitizer · time`) |
| Simulate | Edge fleet | 420 | HealthStress-style synthetic fleet: `edges` · `rate/s` · `jitter %` · `ceiling` inputs, `health` / `therapy` toggles, `▶ start fleet` / `■ stop fleet`; per-edge bars **received vs committed** (yellow Δ = held while ClickHouse is down), `● streaming · n connected` state, explanatory note |
| Simulate | FaultWalker | 400 | matrix `KILL · PAUSE · RESET` × `outbox_append · checkpoint · claim_write · stream_ack_received · stream_ack_committed`; `seed` · `depth`; `▶ walk`; cells pass/fail/running; oracle verdict line |
| Simulate | Breakers | 380 | three cards — `stop bin/session :57020`, `stop salus-clickhouse :59000`, `stop bin/network :57000` — each with state, the consequence text, and `break` / `restore` |
| Simulate | Simulators | 400 | **HealthUnit** deterministic generator (`seed` · `scale` · metric chips `heart_rate resting_hr steps spo2 hrv` · `▶ generate` · digest + `byte-identical on re-run ✓` / `DIFFERS ✗`); **TherapyDevice** dev session stepper (`Advertise → Interrogate → Own → Set Session → Steps → Get Logs → Clear Session`, `⟲ BLE reconnect`, records count, mini log) |

## 4. Interaction model

- Click a chip → Inspector; `×`/`←` → overview. **Focus** on a service scopes SuiteSnapshot +
  Logs to it (chip in the panel header clears it).
- `⌘K` / `Ctrl-K` → command palette (fuzzy list: per-service Drain / Shutdown / Trace / Debug /
  Reset, DrainAll, ShutdownAll, run suite `k`, break/restore infra, switch tab, density);
  `↑↓ navigate · ↵ run · esc close`.
- Destructive actions (Shutdown, ShutdownAll, DrainAll, eject, break) **arm** then fire.
- Panels: drag `⋮⋮` to reorder within the tab; `×` hides; chooser chips show; `reset layout`.
- Split divider drags between 20–80 %.
- Animations: link dash flow (1s / 1.6s linear), chip dot pulse (1.6s), fade-in for new rows
  (`opacity 0 → 1, translateY 4px`, 200ms), braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 4 Hz for anything
  in progress.
- Degraded states are first-class: **Network down** → chips `STALE`, snapshot/logs meta yellow,
  logs buffered `n held`, telemetry link red; **Session down** → Envoy `DENY ALL`, every
  edge-routed link red, fleet `DENY`, denied counters climb; **ClickHouse down** → Health/Therapy
  rows `stalled`, fleet bars split received/committed, ClickHouse `held`; **Postgres down** →
  Auth/Session/Protocol unary errors climb, store bus red.

## 5. Data contracts (what each element binds to)

| Element | Surface |
|---|---|
| Registry rows, chip status/heartbeat, `inflt`, uptime | `Network.GetRegistryStatus` + `GetAllStatus` / `GetAllMetrics` (conflated), `StreamLifecycleEvents` for instant transitions |
| Chip sparks, SuiteSnapshot | `Network.StreamSuiteSnapshot` (1 Hz, **full snapshot per frame — no seq, see §7.8**) — RPC/s = Σ inbound `msg_rate_1s`, I/O = Σ `bps_in_1s + bps_out_1s` per component |
| Logs, Inspector logs | `Network.StreamLogs` (seq resume); per-process `Admin.StreamLogs` via `salus-admin-target` |
| Inspector facts / actions | `Admin.{Ping,GetStatus,GetMetrics,GetConfig(redacted),SetTrace,SetDebug,Drain,Shutdown}`; `Network.{DrainAll,ShutdownAll,Reset}` — all `MUTATING_RPCS`-listed, read-only-guardable, audited |
| Infra pills, Postgres/ClickHouse/Envoy chips, Breakers | bridge `/infra` status probes + `up`/`down` actions (v0.2.2) |
| Sessions panel, eject, Envoy `denied` | `Session` roster + `EjectSession`; ext_authz denials from telemetry |
| Suites / Live / Artifacts | bridge `/harness`: typed suite catalog, run spawner, classified stdout stream, run history, `summary.json` / `junit.xml` ingestion (v0.2.3) |
| Simulate › Edge fleet, Simulators, session stepper | bridge session orchestrator + `Salus.EdgeApplication` (v0.2.4); Health/Therapy query + subscribe surfaces (v0.2.6) |

## 6. Tokens

Colours: `bg0 #0a0d11 · bg1 #0f1318 · bg2 #141920 · bg3 #1a2028 · line #222a34 · line2 #2c3641 ·
fg #dde4ec · fg2 #93a0ae · fg3 #5b6673 · green #5be37a · red #ff6b6b · yellow #f5c542 · cyan
#5fd7e0 · magenta #e08aff · fatal #e03e46 · blue #6f9dff · trace #3aa860`. Log levels: trace
`#3aa860` · debug `#6f9dff` · info fg2 · warn cyan · alarm magenta · error yellow · fatal
`#e03e46` · test fg. Danger surfaces: `rgba(255,107,107,.45)` border / `.06` fill / `.1` armed.

Type: **IBM Plex Sans** 400/500/600 (names, wordmark), **IBM Plex Mono** 400/500/600 (everything
else). Scale: 15 (titles) · 13 (chip name) · 12/11 (`--fs`/`--fs-s`) · 10.5 (log lines, chip
stats) · 9.5 (chip addr/footer) · 9 (spark values) · 8 (pill) · 7.5 (stat labels).

Radii: 2 (buttons) · 3 (pills, tabs, cards) · 7 (chips). Hairlines 1px. Row height `--row`.
Glyph vocabulary (from the terminal harness): `✓ ✗ ⊘ ⚠ ▶ ◐ ○ ◌ ■ ● ⟳ ⟲ ⋮⋮`, `─── Section ───`,
`[▶ RUNNING]`, braille spinner. No icon font, no emoji.

Map these onto `@salus-gui/theme` variables when implementing (one token per semantic role
above); the mock hard-codes them because it has no theme package to import.

## 7. Deviations to resolve at promotion

The mock was drawn before the plan's _Ground truth_ section was verified. **The plan wins**;
record the resolution here, don't redraw the mock.

**Resolved 2026-09-08 at promotion of plan `002`**, each item checked against the Salus tree at
the pinned commit (`2470b82`, v0.8.5) rather than against the plan's prose. Two of the seven
changed the plan rather than the mock, which is the point of doing this against ground truth: a
deviation list resolved from memory only ever confirms what it already said.

1. **Harness flags** — _mock re-cut, and the plan's whitelist corrected._ Verified against
   `test/run_all.py`'s own `add_argument` calls. The mock's `--speed` chip does not exist
   (the real flag is `--no-speed`), and `--plain` is not a chip because the bridge always passes
   it. **The sanitizer selector stays**: `--sanitize [SUFFIX]` is real (`nargs="?"`,
   `const="-tsan"`, documented `-tsan` / `-asan` / `-ubsan`), so the conditional in the original
   item resolves to _keep_, not to a History-row note. The plan's whitelist was therefore
   **incomplete** and gains `--sanitize` — constrained to those three suffixes rather than
   accepting free text, because the value becomes a build-tree path suffix (`build-tsan`) and
   the bridge's spawn surface must not take arbitrary strings from a browser ("Subprocess
   authority is explicit"). `--log-root` exists and is deliberately **not** exposed: the bridge
   owns artifact paths, and letting the browser choose one widens the spawn surface for nothing.
2. **Simulate › session stepper** — _adopt the plan._ Re-cut to the EdgeApplication loop
   (`ListDueRoutines → StartRoutine → SkipRoutine → GetApplicationState`). The mock's
   TherapyDevice walk is a _device_ protocol sequence; the plan's loop is what
   `test/EdgeApp/run_test.py` actually drives and asserts, so it is the one with an oracle. The
   `edgeapplication` catalog entry already carries `dynamicTarget` and the 58070 harness
   convention, so the binding exists. The process list becomes the orchestrator's per-process
   state/port/log-tail rows; the mock's Live › Components block is the right shape.
3. **Infra pills / Breakers** — _adopt the plan, with one consequence the mock hides._ Infra rows
   (Envoy / Postgres / ClickHouse) bind to `/infra` probes and `up`/`down`; service breakers are
   `Admin.Shutdown` + relaunch through the orchestrator. Both audited, both refused in read-only.
   **The mock's instant flip is not achievable**: `/infra` actions shell docker scripts and take
   seconds, so every breaker needs a pending state and a probe-confirmed settle. A control that
   paints its new state before the probe agrees is the "never fake an unpopulated field"
   guardrail in miniature.
4. **Transport** — _adopt the plan._ Every feed through `@salus-gui/streams` (StreamController +
   ConflatedTable, seq resume), with a StreamBadge in the owning panel header; the design's meta
   copy (`seq · n rows`, `disconnected — resume by seq`) is that badge's text. No new component
   is needed: `StreamBadge` shipped in `@salus-gui/ui-kit` at `v0.1.6` and already reports per
   feed rather than globally, which is exactly what this design assumes.
5. **Reconcile, don't trust** — _adopt the plan; it is the load-bearing guardrail._ Live-pane
   terminal state comes from process exit, watchdog-polled at ~1.2 s / 3 s / 8 s; `StartRoutine`
   panels re-read `GetApplicationState` after a terminal disposition. The mock fakes both from
   its own clock, so **no part of the mock's timing behaviour is evidence** — it cannot show the
   failure this guardrail exists to prevent.
6. **EdgeControl (:57060)** — _still deferred, but the stated trigger was wrong._
   `EdgeControl.proto` **is** already vendored, so "add a chip when its proto is vendored" reads
   as satisfied when it is not: the file is 998 lines of messages with **no `service` block and
   no `rpc`s**. Salus lands contracts first (v0.8.1–v0.8.5, which is what `2470b82` pins) and the
   service itself at **v0.8.6, still queued**. The real trigger is therefore: _Salus ships v0.8.6,
   protos are re-synced, and a `SERVICE_CATALOG` entry exists_ — a chip cannot be drawn for a
   target the catalog cannot address. Note for whoever picks it up: `OpenControlChannel` is a
   long-lived bidi stream, so by the architecture rule it is **never forwarded to the browser**;
   the chip will show it the way the console shows the Edge's ingest sessions — through query and
   subscribe surfaces, not by holding the channel.
7. **Read-only mode** — _adopt the plan._ Every mutator (Inspector actions, ShutdownAll, eject,
   run/stop, fleet, breakers, palette commands) renders disabled with a `read-only` tooltip. The
   enforcement already exists and is not the GUI's job: the bridge refuses mutating RPCs
   fleet-wide (`v0.1.5`, tested), and the plan extends the same switch to `/harness`, `/infra`
   and the orchestrator. The GUI renders the state; it must never be the thing that prevents the
   call.
8. **`StreamSuiteSnapshot` is not seq-resumable** — _found at `v0.2.1`; plan, data contract and
   footer copy all corrected._ The plan's ground truth listed it beside the log and lifecycle
   feeds as seq-resumable, and §5's data-contract row said "1 Hz, seq-resumable". The proto says
   otherwise: `SuiteSnapshot` has **no `seq` field** and `StreamSuiteSnapshotRequest` is empty —
   every frame is complete state (`snapshot_at_us` + `components[]` + `rows[]`). It is a
   **Resnapshot** feed: reconnect takes the next frame and replaces, and there is nothing to
   resume from. The consequence for this design is concrete — §1's footer specified
   `seq 4,821`, and **there is no such number to show**; it now renders snapshot age. A seq there
   would have been the console inventing a value in its own chrome, the same failure the
   `⊘ SKIP` / `STALE` rules exist to prevent. `StreamLogs` and `StreamLifecycleEvents` _are_
   seq-resumable and unaffected (`AggregatedLogEntry.seq`, `LifecycleEvent.seq`).

## 8. Implementation notes

- Build the **chip** once as a ui-kit component (`ServiceChip`: `status`, `name`, `port`,
  `addr`, `stats[3]`, `sparks?`, `footer?`, `selected`) — it is the same element seven times.
- The topology is an SVG schematic with **fixed positions** (no force layout) and
  `<foreignObject>` chips; keep the viewBox aspect (1180×360) so the half-height strip renders
  chips at ~0.85×.
- The Workbench is the dock: panels register with a basis width; packing = row-fill by width,
  equal-height rows, internal scroll. Persist per-tab order/hidden + split in the `/kv` store
  once it exists (the mock uses localStorage).
- `⊘ SKIP` is never folded into green; `STALE` is never a heuristic — both are derived from the
  authority (probe / seq), per the plan's guardrails.
