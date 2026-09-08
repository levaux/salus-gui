---
name: Documentation Refactor
description: Restructure salus-gui project documentation for clarity and accessibility
tags: documentation, refactoring, organization
---

# Documentation Refactor

Refactor documentation for salus-gui — the web operations console for the Salus platform
(a SvelteKit SPA + a TypeScript bridge process speaking natively to the Salus gRPC service
fleet, used for regression-test control, operational control, simulation, and — post-deploy —
operations management).

1. **Analyze current state**: Review `README.md`, `CLAUDE.md`, `docs/`, the per-package /
   per-app `README.md` files, and any inline comments.
2. **Root `README.md`**: Keep as entry point — overview, architecture (browser → bridge →
   service fleet), workspace layout table, quickstart (install + gen + dev stack), testing.
3. **`docs/` structure** — keep the established split; create or reorganize toward:
   - architecture / topology — the one-bridge contract (`/rpc` Connect ⇄ gRPC forward,
     bridge-local control surfaces), stream reconnect contracts, the service catalog.
   - dev-setup — Node/pnpm/mkcert prerequisites, codegen-before-typecheck, the mock stack
     vs. the live Salus fleet.
   - adr/ — one file per accepted architecture decision; never rewrite an accepted ADR,
     supersede it.
   - harness integration — how the console drives the Salus regression suites and renders
     their results.
4. **Plans**: planning docs live in `docs/plans/`; their canonical state is `docs/plans/INDEX.md`.
   Respect the queued / in-progress / complete lifecycle (CLAUDE.md → Plans Lifecycle) — don't
   delete completed plans; they stay as historical record.
5. **Proto documentation**: `packages/proto/` documents the vendoring flow (commit lock,
   drift gate, breaking gate) — keep that README current with the tooling.
6. **Design decisions** (bridge-vs-proxy, grid/dock/chart library choices, transport contracts)
   belong in `docs/adr/` with the rationale, not just in code comments.
7. **Keep docs code-first**: prefer short explanations + real code snippets over long prose.

Do NOT generate web-style docs (no REST API docs, no deployment guides, no K8s content).
Honour the commit conventions in CLAUDE.md when touching source.
