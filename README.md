# salus-gui

The web operations console for the **Salus** platform: a dashboard for running the regression-test
harness, operational control of the Salus service fleet, and simulation/experimentation against the
Edge application — built first as a development and test instrument, carried forward as the
operations-management console once the platform is deployed.

**Status: bootstrap.** The repository currently carries the planning and agent-management apparatus
only — no product code yet. The architecture (a SvelteKit 2 + Svelte 5 SPA plus a single TypeScript
bridge process speaking Connect ⇄ gRPC to the Salus fleet) and the build-out are specified in the
two founding plans:

- [docs/plans/001-salus-gui-repo.md](docs/plans/001-salus-gui-repo.md) — the `v0.1.x` workspace-scaffold
  train: pnpm monorepo, the proto vendoring pipeline (pinned to a Salus commit, buf codegen,
  drift + wire-compat gates), the five packages, the bridge (`salus-bridged`, `:56400`), the SPA
  shell with a first live fleet panel, and CI.
- [docs/plans/backlog/harness-control-gui.md](docs/plans/backlog/harness-control-gui.md) — the `v0.2.x`
  control-surface train: fleet observability, infra lifecycle control, the regression-harness
  console over `../salus/test/run_all.py`, the manually-driven end-to-end platform session
  (full fleet + Edge application control), then the experimentation surfaces.

Plan lifecycle state lives in [docs/plans/INDEX.md](docs/plans/INDEX.md); the version log in
[docs/commit-history.md](docs/commit-history.md); agent conventions in [CLAUDE.md](CLAUDE.md).
The Salus backend lives in the sibling repo at `../salus` — this repo vendors its protos at a
pinned commit and speaks to it only over the wire.
