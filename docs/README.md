# salus-gui documentation

**One rule: a document belongs here when a reader consults it to understand what the console
does _today_.** Reference for built state, and the runbooks for operating it. Nothing
forward-looking.

The rule exists because a folder that holds shipped-state reference and proposals at once gives
the reader no way to tell which they have opened — they look identical from the filename. Three
neighbours carry the rest:

| Folder                                   | Holds                                            | Test                          |
| ---------------------------------------- | ------------------------------------------------ | ----------------------------- |
| **`docs/`**                              | reference + runbooks                             | _is it built?_                |
| [`docs/plans/`](plans/)                  | the work lifecycle — backlog, running, completed | _is it a stage ladder?_       |
| [`research/`](../research/)              | open questions, option spaces                    | _is the question still open?_ |
| [`commit-history.md`](commit-history.md) | the release ledger                               | _did it ship, and when?_      |

A document that is **partly** forward-looking still leaves: split it, keep the shipped-state
half, and send the proposal half to the backlog or `research/`.

`tools/check-plans.py` enforces the parts of this that are mechanical (register consistency and
link integrity into `docs/plans/` and `research/`).

## Where things are

- [commit-history.md](commit-history.md) — the version log; the root `package.json` `"version"`
  is the source of truth it mirrors.
- [plans/INDEX.md](plans/INDEX.md) — the plans register.
- `dev-setup.md`, `adr/`, the harness-integration reference — arrive with the two founding
  plans; each package and app carries its own README as the scaffold lands.
