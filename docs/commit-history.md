# Commit History

Version history for the salus-gui console, grouped by major/minor release. The `"version"` in the
root `package.json` is the single source of truth; bump it with each versioned commit and add a row
here. Non-versioned commits (`docs:` / `proto:` / `test:` / `infra:` / `chore:` / `fix:`) get no
row — `git log` carries them.

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
