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
[docs/plans/salus-gui-repo.md](plans/salus-gui-repo.md) starts — the workspace scaffold, the
proto vendoring pipeline, the bridge, and the SPA shell.
