# Plan Index

Single source of truth for the lifecycle state of every plan in `docs/plans/`.
Update this file on every state transition.

## States

- **queued** — plan written, work not yet started.
- **in-progress** — work has started.
- **parked** — work started but paused indefinitely (blocked, lower priority, awaiting an external
  dependency). The plan file stays; resuming bumps the state back to `in-progress`.
- **complete** — implementation shipped. Plan stays here as a historical record; the affected
  architecture docs in `docs/` are updated.

## Plans

Order: in-progress first, then queued, then parked, then complete (earliest first within the complete
block).

| State  | Plan                                                   | Started | Completed | Architecture docs updated on completion |
|--------|--------------------------------------------------------|---------|-----------|------------------------------------------|
| queued | [salus-gui-repo.md](salus-gui-repo.md)                 |         |           | The `v0.1.x` scaffold train — workspace + toolchain, proto vendoring pipeline, the five packages, the bridge, the SPA shell + first fleet panel, CI. Releases as `v0.2.0`. |
| queued | [harness-control-gui.md](harness-control-gui.md)       |         |           | The `v0.2.x` control-surface train — fleet observability, infra control, the regression-harness console, the manually-driven end-to-end platform session, then the experimentation surfaces. Opens when the scaffold train releases; releases as `v0.3.0`. |

## How to update this file

**Adding a new plan (queued):**

1. Write `docs/plans/<name>.md`.
2. Add a row here with state `queued`.

**Starting a plan (queued → in-progress):**

1. Bump the row: state → `in-progress`, fill `Started`.

**Completing a plan (in-progress → complete):**

1. Bump the row: state → `complete`, fill `Completed`, populate `Architecture docs updated`.
2. Edit the affected `docs/*.md` architecture files so they reflect the shipped state.
3. Record the shipping version in [docs/commit-history.md](../commit-history.md).
4. Plan file stays at `docs/plans/<name>.md` (do not delete — historical record).

**Parking a plan (in-progress → parked):**

1. Bump the row: state → `parked`. Keep the original `Started` date.
2. Annotate `Architecture docs updated` with the reason for parking + the resume condition.
3. Plan file stays at `docs/plans/<name>.md`. Resuming bumps the state back to `in-progress`.
