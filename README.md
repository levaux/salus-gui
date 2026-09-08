# salus-gui

The web operations console for the **Salus** platform: a dashboard for running the regression-test
harness, operational control of the Salus service fleet, and simulation/experimentation against the
Edge application — built first as a development and test instrument, carried forward as the
operations-management console once the platform is deployed.

**Status: `v0.2.0` — a walking skeleton.** Every layer is present and the console runs: a
SvelteKit 2 + Svelte 5 SPA, a single TypeScript bridge process (`salus-bridged`, `:56400`)
speaking Connect ⇄ gRPC to the Salus fleet, protos vendored at a pinned Salus commit behind drift
and wire-compatibility gates, and a deterministic mock of the fleet that makes the whole thing
runnable with no Salus checkout at all. One panel is live — fleet registry and the aggregated log
feed — which is enough to prove the path end to end but is not yet an operations console.

Next is [docs/plans/002-harness-control-gui.md](docs/plans/002-harness-control-gui.md),
the `v0.2.x` control-surface train: fleet observability, infra lifecycle control, the
regression-harness console over `../salus/test/run_all.py`, the manually-driven end-to-end
platform session (full fleet + Edge application control), then the experimentation surfaces. Its
intended operator surface is drawn in
[design/harness-control-gui/](design/harness-control-gui/README.md).

## Running it

```bash
pnpm install                              # also generates the proto code
pnpm --filter @salus-gui/bridge cert      # once — the bridge requires TLS
./infra/up.sh                             # mock fleet + bridge, fully offline
curl -sk --http2 https://localhost:56400/bridge/info
./infra/down.sh
```

That serves the console at <http://localhost:5173>. `./infra/up.sh --live` points the bridge at a
real Salus fleet instead; bring the platform up first with `../salus/infra/db/up.sh` and
`../salus/infra/envoy/up.sh`. Full options, and what each script checks, are in
[infra/README.md](infra/README.md); first-time setup and the repo's surprises are in
[docs/dev-setup.md](docs/dev-setup.md).

Plan lifecycle state lives in [docs/plans/INDEX.md](docs/plans/INDEX.md); the version log in
[docs/commit-history.md](docs/commit-history.md); agent conventions in [CLAUDE.md](CLAUDE.md).
The Salus backend lives in the sibling repo at `../salus` — this repo vendors its protos at a
pinned commit and speaks to it only over the wire.
