#!/usr/bin/env python3
"""plans — the plans tree is derived from docs/plans/INDEX.md, never maintained by hand.

A plan's lifecycle state decides where its file lives and what it is called:

    docs/plans/backlog/<name>.md         written, unnumbered, no INDEX row
    docs/plans/NNN-<name>.md             running or parked — numbered, has an INDEX row
    docs/plans/completed/NNN-<name>.md   finished; the number is kept forever

The number is allocated once, at promotion to running, and never changes again.
That is what makes this tool small: there is no ordering to maintain, because
promotion produces the order for free, so a transition is only ever a move.

Moving a plan breaks every inbound reference to it, and references accumulate —
`docs/commit-history.md` alone will carry one per versioned row. So a move is
never just a move: `sync` rewrites every reference in the tree in the same
pass, through two rules, because a path is written two different ways:

  1. **Markdown link targets** — ``](docs/plans/x.md)``, ``](../plans/x.md)``,
     ``](x.md)``. These are resolved to an absolute path and re-relativised
     against the referencing file's *new* directory. That second half matters as
     much as the first: when a plan itself moves, its own outbound
     ``](../commit-history.md)`` links must be rewritten even though
     `commit-history.md` never moved.

  2. **Bare path strings** — a TS string literal, a Python comment, a `.proto`
     docstring. These are not links and rule 1 cannot see them, so they get a
     plain repo-relative substitution.

Two directories are excluded from both rules on purpose, because their bytes
are held by gates rather than kept current:

  * `packages/proto/vendor/` — vendored upstream protos, sha256-pinned by the
    commit lock; `sync-protos:check` fails on any byte that differs from the
    lock, so a rewritten comment would redden the drift gate on files nobody
    synced. A file whose content is evidence is not a file whose references
    may be kept current.
  * `packages/proto/src/gen/` — committed codegen; the regen-and-diff CI gate
    holds it byte-identical to what the generator emits, and the generator
    knows nothing about plan moves.

Stdlib only: this has to run on a bare checkout, with no node_modules, no venv
and no network.

    tools/plans.py check                 report drift between INDEX and the tree
    tools/plans.py sync [--dry-run]      make the tree match INDEX
    tools/plans.py move --map FILE       apply a one-off move map (reorganisations)
    tools/plans.py render-index [--check]  regenerate INDEX's ## Backlog section
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLANS = ROOT / "docs" / "plans"
INDEX = PLANS / "INDEX.md"
BACKLOG = PLANS / "backlog"
COMPLETED = PLANS / "completed"

# Path prefixes never rewritten (see the module docstring for the two gates
# that hold their bytes; the rest are build products and dependencies, which
# git ls-files normally never lists anyway).
EXCLUDED_PREFIXES = (
    "packages/proto/vendor/",
    "packages/proto/src/gen/",
    "node_modules/",
)

# Text file types that can carry a path reference. Anything else is left alone.
TEXT_SUFFIXES = {".md", ".py", ".sh", ".ts", ".js", ".svelte", ".css", ".html",
                 ".proto", ".json", ".yml", ".yaml", ".toml", ".txt", ".sql",
                 ".d2"}

# ``[text](target)`` — text captured too, because some files use the path itself
# as the link text and it would otherwise be left contradicting the target.
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")

# An INDEX row: | 001 | running | [001-salus-gui-repo.md](001-salus-gui-repo.md) | ...
ROW_RE = re.compile(r"^\|\s*(\d{3})\s*\|\s*(running|parked|completed)\s*\|\s*"
                    r"\[[^\]]*\]\(([^)#]+\.md)\)")

# A numbered plan filename: 001-salus-gui-repo.md
NUMBERED_RE = re.compile(r"^(\d{3})-(.+)\.md$")


# --------------------------------------------------------------------------
# repo inventory
# --------------------------------------------------------------------------

def tracked_files() -> list[Path]:
    """Every tracked text file that is eligible for a reference rewrite."""
    out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"],
                         capture_output=True, text=True, check=True).stdout
    files: list[Path] = []
    for rel in out.split("\0"):
        if not rel:
            continue
        if rel.startswith(EXCLUDED_PREFIXES):
            continue
        path = ROOT / rel
        if path.suffix.lower() in TEXT_SUFFIXES and path.is_file():
            files.append(path)
    return files


# --------------------------------------------------------------------------
# the rewriter
# --------------------------------------------------------------------------

def _rewrite_links(text: str, ref_old: Path, ref_new: Path,
                   moves: dict[Path, Path]) -> str:
    """Rule 1 — resolve every ``](target)``, then re-relativise it.

    Both ends can move: `moves` may rename the target, and `ref_new` may differ
    from `ref_old` because the referencing file itself moved. A link is rewritten
    when either is true, which is why an untouched target still needs work.

    Link text is left alone — it is prose, and a `commit-history.md` row names
    a plan rather than quotes its path. The one exception is a file that uses
    the path *as* the text; leaving that would print one path and link another.
    Such a label keeps the shape it had: a bare filename stays a bare filename
    (the new one), because `[salus-gui-repo.md]` reads and a full relative path
    does not.
    """
    def sub(m: re.Match) -> str:
        label, target = m.group(1), m.group(2)
        if target.startswith(("http://", "https://", "mailto:", "#", "/")):
            return m.group(0)
        path_part, _, anchor = target.partition("#")
        if not path_part:
            return m.group(0)
        old_abs = (ref_old.parent / path_part).resolve()
        new_abs = moves.get(old_abs, old_abs)
        if new_abs == old_abs and ref_new == ref_old:
            return m.group(0)                   # nothing at either end moved
        rel = os.path.relpath(new_abs, ref_new.parent)
        new_target = f"{rel}#{anchor}" if anchor else rel
        new_label = label
        if label.strip() == path_part:
            new_label = rel if "/" in label.strip() else os.path.basename(rel)
        return f"[{new_label}]({new_target})"

    return LINK_RE.sub(sub, text)


def _rewrite_bare(text: str, moves: dict[Path, Path],
                  prefixes: list[tuple[str, str]]) -> str:
    """Rule 2 — plain repo-relative substitution for paths that are not links.

    A TS string literal, a `.proto` comment, a bare mention in prose. Matches
    preceded by ``](`` are skipped: rule 1 owns those and has already run.
    """
    for old_abs, new_abs in moves.items():
        old_rel = os.path.relpath(old_abs, ROOT)
        new_rel = os.path.relpath(new_abs, ROOT)
        text = re.sub(r"(?<!\]\()" + re.escape(old_rel), new_rel, text)
        # The same path is also written without the leading `docs/` by files
        # that sit inside docs/ (commit-history.md rows). Only when the short
        # form still names a directory: for a file at docs/ root it would decay
        # to a bare filename and match far too much, including link text that
        # rule 1 deliberately left alone.
        if old_rel.startswith("docs/"):
            short_old, short_new = old_rel[5:], new_rel
            if short_old != short_new and "/" in short_old:
                text = re.sub(r"(?<!\]\()(?<![\w/.-])" + re.escape(short_old),
                              short_new, text)
    for old_pref, new_pref in prefixes:
        text = re.sub(r"(?<!\]\()" + re.escape(old_pref), new_pref, text)
    return text


def apply_moves(moves: dict[Path, Path], prefixes: list[tuple[str, str]],
                dry_run: bool) -> int:
    """Rewrite every reference, then move the files. Returns files changed.

    Content is rewritten *before* anything moves, so a referencing file's own
    location still resolves its relative links correctly.
    """
    changed = 0
    for path in tracked_files():
        original = path.read_text()
        text = _rewrite_links(original, path, moves.get(path, path), moves)
        text = _rewrite_bare(text, moves, prefixes)
        if text != original:
            changed += 1
            if dry_run:
                print(f"  rewrite  {path.relative_to(ROOT)}")
            else:
                path.write_text(text)

    for old, new in sorted(moves.items()):
        if dry_run:
            print(f"  move     {os.path.relpath(old, ROOT)} -> "
                  f"{os.path.relpath(new, ROOT)}")
            continue
        new.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "-C", str(ROOT), "mv", str(old), str(new)],
                       check=True)
    return changed


# --------------------------------------------------------------------------
# INDEX
# --------------------------------------------------------------------------

def index_rows() -> list[tuple[str, str, str]]:
    """(seq, state, link target) for every row, in file order."""
    if not INDEX.exists():
        return []
    rows = []
    for line in INDEX.read_text().splitlines():
        m = ROW_RE.match(line)
        if m:
            rows.append((m.group(1), m.group(2), m.group(3)))
    return rows


def _candidates(target: str, stem: str) -> tuple[Path, ...]:
    """Every place an indexed plan may currently live, in match order.

    `backlog/<stem>.md` is the one entry whose FILENAME differs from the
    row's target, and it is why it has to be derived rather than guessed: a
    promotion allocates the number at the moment of the move, so INDEX names
    `001-salus-gui-repo.md` while the file on disk is still
    `salus-gui-repo.md`. Omitting this candidate would make backlog → running
    the one transition `sync` could not perform — it would leave `current` at
    the row's own target, which then equals the destination and is discarded
    as a no-op, so the tool would report "nothing to move" while `check`
    called the tree clean.
    """
    return ((PLANS / target),
            COMPLETED / Path(target).name,
            PLANS / Path(target).name,
            BACKLOG / f"{stem}.md")


def _stem_of(target: str) -> str:
    m = NUMBERED_RE.match(Path(target).name)
    return m.group(2) if m else Path(target).stem


def desired_paths() -> dict[Path, Path]:
    """Where every indexed plan should live, keyed by where it lives now."""
    want: dict[Path, Path] = {}
    for seq, state, target in index_rows():
        stem = _stem_of(target)
        current = (PLANS / target).resolve()
        if not current.exists():
            for candidate in _candidates(target, stem)[1:]:
                if candidate.exists():
                    current = candidate.resolve()
                    break
        name = f"{seq}-{stem}.md"
        home = COMPLETED if state == "completed" else PLANS
        want[current] = (home / name).resolve()
    return {old: new for old, new in want.items() if old != new}


def missing_indexed_plans() -> list[str]:
    """Indexed rows whose file cannot be found in any allowed location.

    `desired_paths()` structurally cannot report these: when no candidate
    exists it leaves `current` at the row's own target, which then equals the
    computed destination and is filtered out as a no-op. A numbered row
    pointing at a file that does not exist would therefore read as
    "the tree matches INDEX.md" — silence in precisely the case the register
    exists to catch.
    """
    missing = []
    for seq, _state, target in index_rows():
        if not any(c.exists() for c in _candidates(target, _stem_of(target))):
            missing.append(f"Seq {seq}: {target} is indexed but not in the tree")
    return missing


def render_backlog() -> str:
    """The generated ## Backlog table — sorted, because the backlog is unordered."""
    lines = ["## Backlog", "",
             "<!-- generated by tools/plans.py render-index — "
             "do not edit by hand -->", "",
             "Written, not yet promoted. No number and no INDEX state until "
             "work starts.", "",
             "| Plan | Title |", "|---|---|"]
    for path in sorted(BACKLOG.glob("*.md")) if BACKLOG.exists() else []:
        title = ""
        for line in path.read_text().splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        lines.append(f"| [{path.name}](backlog/{path.name}) | {title} |")
    return "\n".join(lines) + "\n"


def splice_backlog(text: str, rendered: str) -> str:
    """Replace the ## Backlog section, or append it if absent."""
    m = re.search(r"^## Backlog\s*$", text, re.MULTILINE)
    if not m:
        return text.rstrip() + "\n\n" + rendered
    nxt = re.search(r"^## ", text[m.end():], re.MULTILINE)
    end = m.end() + nxt.start() if nxt else len(text)
    return text[:m.start()] + rendered + "\n" + text[end:]


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_check(_: argparse.Namespace) -> int:
    drift = desired_paths()
    stale = splice_backlog(INDEX.read_text(), render_backlog()) \
        if INDEX.exists() else ""
    problems = []
    for old, new in sorted(drift.items()):
        problems.append(f"{os.path.relpath(old, ROOT)} should be "
                        f"{os.path.relpath(new, ROOT)}")
    problems.extend(missing_indexed_plans())
    if INDEX.exists() and stale != INDEX.read_text():
        problems.append("INDEX.md: the generated ## Backlog section is stale "
                        "(run: tools/plans.py render-index)")
    if problems:
        print(f"✗ plans: {len(problems)} drift(s) between INDEX.md and the tree\n")
        for p in problems:
            print(f"  {p}")
        return 1
    print("✓ plans: the tree matches INDEX.md")
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    moves = desired_paths()
    if not moves:
        print("plans: nothing to move")
    else:
        apply_moves(moves, [], args.dry_run)
    if not args.dry_run and INDEX.exists():
        INDEX.write_text(splice_backlog(INDEX.read_text(), render_backlog()))
    return 0


def cmd_move(args: argparse.Namespace) -> int:
    spec = json.loads(Path(args.map).read_text())
    moves = {(ROOT / e["from"]).resolve(): (ROOT / e["to"]).resolve()
             for e in spec.get("files", [])}
    missing = [str(p.relative_to(ROOT)) for p in moves if not p.exists()]
    if missing:
        print("plans: map names files that do not exist:", file=sys.stderr)
        for m in missing:
            print(f"  {m}", file=sys.stderr)
        return 2
    prefixes = [(e["from"], e["to"]) for e in spec.get("prefixes", [])]
    changed = apply_moves(moves, prefixes, args.dry_run)
    verb = "would rewrite" if args.dry_run else "rewrote"
    print(f"plans: {len(moves)} move(s), {verb} {changed} file(s)")
    return 0


def cmd_render_index(args: argparse.Namespace) -> int:
    current = INDEX.read_text()
    updated = splice_backlog(current, render_backlog())
    if args.check:
        if current != updated:
            print("✗ plans: INDEX.md ## Backlog section is stale", file=sys.stderr)
            return 1
        print("✓ plans: INDEX.md ## Backlog section is current")
        return 0
    INDEX.write_text(updated)
    print("plans: rendered INDEX.md ## Backlog")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("check", help="report drift, change nothing")
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("sync", help="make the tree match INDEX.md")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_sync)

    p = sub.add_parser("move", help="apply a one-off move map")
    p.add_argument("--map", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_move)

    p = sub.add_parser("render-index", help="regenerate the ## Backlog section")
    p.add_argument("--check", action="store_true")
    p.set_defaults(fn=cmd_render_index)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
