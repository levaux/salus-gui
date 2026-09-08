#!/usr/bin/env python3
"""check-plans — the doc-lint behind the plans register.

Two jobs, and they are different in kind.

**1. The register is honest.** `docs/plans/INDEX.md` is the authority the tree
is derived from, so a disagreement between the two is a fault rather than a
style question. The invariant: **numbered ⟺ listed in INDEX**. A number is
proof a plan was promoted to real work, and INDEX is the register of allocated
numbers. Backlog plans are the mirror image: unnumbered, and no row.

**2. Nothing rots silently.** Every outbound link in every plan resolves —
completed plans included, because a link is not an architectural claim: it
resolves or it does not, and a completed plan whose references have rotted is
a worse record than one whose haven't. And every `](…)` link into
`docs/plans/` or `research/` resolves, from anywhere in the repository —
without that, renaming a *completed* plan breaks its inbound references
silently, and completed plans are precisely the heavily-referenced ones.

An architecture-rebase gate (a live plan claiming a port or surface the
current architecture has reassigned) belongs here too, run over backlog +
running + parked plans only — a completed plan's claims are not drift, they
are what was true when it shipped. It arrives once the repo has a canonical
surface to bind it to (the service catalog in `packages/proto`); adding a
check with nothing canonical to compare against would gate nothing.

Pure stdlib. No DB, no binary, no port, no node_modules — a drift gate that
self-skips goes quiet on exactly the machine where nobody set the environment
up.

    tools/check-plans.py            # exit 0 = clean
    tools/check-plans.py --root T   # lint a fixture tree — how a test proves
                                    # each rule FAILS on a violation of it
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLANS = ROOT / "docs" / "plans"
RESEARCH = ROOT / "research"
BACKLOG = PLANS / "backlog"
COMPLETED = PLANS / "completed"
INDEX = PLANS / "INDEX.md"

sys.path.insert(0, str(Path(__file__).resolve().parent))
import plans as plans_tool  # noqa: E402

LINK_RE = re.compile(r"\]\(([^)]+\.(?:md|svg|d2|sql|sh|html|ts|py|json))\)")
ANY_LINK_RE = re.compile(r"\]\(([^)\s]+)\)")
STATUS_RE = re.compile(r"^\*\*Status\*\*:\s*(\w[\w-]*)", re.MULTILINE)
SECTION_RE = re.compile(r"^## (Running|Parked|Completed)\s*$", re.MULTILINE)
NUMBERED_RE = re.compile(r"^(\d{3})-(.+)\.md$")
MATRIX_RE = re.compile(r"<!--\s*resolution-matrix:\s*([^>]+?)\s*-->")
TARGET_RE = re.compile(r"(?<![\w-])(D\d+|§\d+)(?![\w.])")
ITEM_RE = re.compile(r"\*\*([SVC]\d+)\*\*")


def _rebase(root: Path) -> None:
    """Point every path at another tree. Only `--root` uses this."""
    global ROOT, PLANS, RESEARCH, BACKLOG, COMPLETED, INDEX
    ROOT, PLANS, RESEARCH = root, root / "docs" / "plans", root / "research"
    BACKLOG, COMPLETED = PLANS / "backlog", PLANS / "completed"
    INDEX = PLANS / "INDEX.md"
    plans_tool.ROOT, plans_tool.PLANS = ROOT, PLANS
    plans_tool.INDEX, plans_tool.BACKLOG = INDEX, BACKLOG
    plans_tool.COMPLETED = COMPLETED


def read_index() -> tuple[dict[str, tuple[str, str]], list[str]]:
    """{filename: (seq, state)}, plus any section/ordering faults found."""
    rows: dict[str, tuple[str, str]] = {}
    failures: list[str] = []
    section: str | None = None
    last: dict[str | None, str] = {}
    for line in INDEX.read_text().splitlines():
        s = SECTION_RE.match(line)
        if s:
            section = s.group(1).lower()
            continue
        m = plans_tool.ROW_RE.match(line)
        if not m:
            continue
        seq, state, target = m.groups()
        rows[Path(target).name] = (seq, state)
        where = (section or "?").title()
        if state != section:
            failures.append(f"INDEX.md: {target} is `{state}` but sits under "
                            f"## {where}")
        prev = last.get(section)
        if prev is not None and seq >= prev:
            failures.append(f"INDEX.md: Seq {seq} follows {prev} under "
                            f"## {where} — tables read newest first, so Seq "
                            f"must descend")
        last[section] = seq
    return rows, failures


def check_register(rows, failures) -> dict[str, Path]:
    """numbered ⟺ INDEX row, filename ⟺ Seq, state ⟺ directory."""
    found = sorted(p for p in PLANS.rglob("*.md") if p.name != "INDEX.md")
    on_disk: dict[str, Path] = {}
    for path in found:
        if path.name in on_disk:
            failures.append(f"{path.relative_to(ROOT)}: a second file named "
                            f"{path.name} exists at "
                            f"{on_disk[path.name].relative_to(ROOT)} — a plan "
                            f"name is its identity and must be unique")
        on_disk.setdefault(path.name, path)

    for path in found:
        name = path.name
        rel = path.relative_to(ROOT)
        numbered = NUMBERED_RE.match(name)
        if path.parent == BACKLOG:
            if numbered:
                failures.append(f"{rel}: backlog plans carry no number — a "
                                f"number is allocated at promotion")
            if name in rows:
                failures.append(f"{rel}: in the backlog but has an INDEX row")
            continue
        if not numbered:
            failures.append(f"{rel}: outside the backlog, so it must be named "
                            f"NNN-<name>.md")
            continue
        if name not in rows:
            failures.append(f"{rel}: numbered but has no INDEX row "
                            f"(numbered ⟺ listed in INDEX)")
            continue
        seq, state = rows[name]
        if seq != numbered.group(1):
            failures.append(f"{rel}: filename says {numbered.group(1)}, INDEX "
                            f"Seq says {seq}")
        home = COMPLETED if state == "completed" else PLANS
        if path.parent != home:
            failures.append(f"{rel}: state `{state}` belongs in "
                            f"{home.relative_to(ROOT)}/")

    for name, (seq, _) in sorted(rows.items()):
        if name not in on_disk:
            failures.append(f"INDEX.md: lists {name} (Seq {seq}) but the file "
                            f"is missing")

    seqs = [s for s, _ in rows.values()]
    for dupe in sorted({s for s in seqs if seqs.count(s) > 1}):
        failures.append(f"INDEX.md: Seq {dupe} is allocated more than once — "
                        f"numbers are never reused")
    return on_disk


def check_status_lines(rows, on_disk, failures) -> None:
    """Every plan declares, in its own header, the state the register gives it."""
    for name, path in sorted(on_disk.items()):
        want = "backlog" if path.parent == BACKLOG else rows.get(name, ("", ""))[1]
        if not want:
            continue
        m = STATUS_RE.search(path.read_text())
        rel = path.relative_to(ROOT)
        if not m:
            failures.append(f"{rel}: no `**Status**: {want}` line under the title")
        elif m.group(1) != want:
            failures.append(f"{rel}: declares `**Status**: {m.group(1)}` but "
                            f"the register says `{want}`")


def check_links(plans, failures) -> None:
    """Outbound links resolve. Runs over EVERY plan, completed ones included."""
    for plan in sorted(plans):
        rel = plan.relative_to(ROOT)
        for ln, line in enumerate(plan.read_text().splitlines(), 1):
            for tgt in LINK_RE.findall(line):
                if tgt.startswith(("http://", "https://", "mailto:")):
                    continue
                if not (plan.parent / tgt.split("#", 1)[0]).resolve().exists():
                    failures.append(f"{rel}:{ln}: broken link → {tgt}")


def check_resolution_matrix(failures) -> None:
    """A dispositioning matrix still matches the document it dispositions into.

    A research document that gets promoted leaves a matrix behind: every
    requirement it raised, and what the plan turned that requirement into. The
    matrix is written once, pre-promotion, and then both documents move — the
    plan renumbers a design section, the research document gains a requirement
    nobody dispositioned. Neither edit breaks a link, so neither is visible.

    Declared rather than discovered: a document opts in with

        <!-- resolution-matrix: <relative path to the normative document> -->

    immediately above its table. Two directions, because only the pair is
    worth having — one alone is satisfied by an empty matrix or an unread one:

      * every target token in the final column (`D7`, `§10`) names a real
        heading in the normative document; and
      * every requirement id the document sets in bold **anywhere** has a
        matrix row, so raising one without dispositioning it is the failure.
    """
    docs = list(PLANS.rglob("*.md"))
    if RESEARCH.exists():
        docs += list(RESEARCH.rglob("*.md"))
    for doc in sorted(docs):
        text = doc.read_text()
        marker = MATRIX_RE.search(text)
        if not marker:
            continue
        rel = doc.relative_to(ROOT)
        target = (doc.parent / marker.group(1).strip()).resolve()
        if not target.exists():
            failures.append(f"{rel}: resolution-matrix names {marker.group(1)},"
                            f" which does not exist")
            continue
        headings = set()
        for line in target.read_text().splitlines():
            got = re.match(r"^#{2,4} (D\d+|\d+)\b", line)
            if got:
                headings.add(got.group(1) if got.group(1).startswith("D")
                             else "§" + got.group(1))

        rows, seen = 0, set()
        for ln, line in enumerate(text[marker.end():].splitlines(),
                                  text[:marker.end()].count("\n") + 1):
            if not line.startswith("|"):
                if rows:                      # the table has ended
                    break
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 2 or set(cells[0]) <= set("-: "):
                continue
            item = re.match(r"\*\*([SVC]\d+)\*\*", cells[0])
            if not item:
                continue
            rows += 1
            if item.group(1) in seen:
                failures.append(f"{rel}:{ln}: {item.group(1)} has two "
                                f"matrix rows")
            seen.add(item.group(1))
            for tok in TARGET_RE.findall(cells[-1]):
                if tok not in headings:
                    failures.append(
                        f"{rel}:{ln}: {item.group(1)} dispositions into {tok}, "
                        f"which {target.name} does not declare")
        if not rows:
            failures.append(f"{rel}: declares a resolution-matrix and has no "
                            f"rows under it")
            continue
        for raised in sorted(set(ITEM_RE.findall(text))):
            if raised not in seen:
                failures.append(f"{rel}: raises {raised} and dispositions it "
                                f"nowhere in the matrix")


def check_inbound(failures) -> None:
    """Nothing anywhere in the repo links into docs/plans/ or research/ in vain."""
    got = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"],
                         capture_output=True, text=True)
    if got.returncode == 0:
        entries = got.stdout.split("\0")
    else:                       # a fixture tree under --root is not a repo
        entries = [str(p.relative_to(ROOT)) for p in ROOT.rglob("*.md")]
    for entry in entries:
        if not entry.endswith(".md"):
            continue
        src = ROOT / entry
        if not src.exists():
            continue
        for ln, line in enumerate(src.read_text().splitlines(), 1):
            for tgt in ANY_LINK_RE.findall(line):
                if tgt.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                path = tgt.split("#", 1)[0]
                dest = (src.parent / path).resolve()
                if not str(dest).startswith((str(PLANS), str(RESEARCH))):
                    continue
                if not dest.exists():
                    failures.append(f"{entry}:{ln}: dangling link → "
                                    f"{os.path.relpath(dest, ROOT)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="plans register doc-lint")
    ap.add_argument("--root", type=Path,
                    help="lint a tree other than this checkout — a lint test "
                         "uses it to prove each check FAILS on a fixture that "
                         "violates it")
    args = ap.parse_args()

    if args.root:
        _rebase(args.root.resolve())

    rows, failures = read_index()
    on_disk = check_register(rows, failures)
    check_status_lines(rows, on_disk, failures)

    if plans_tool.splice_backlog(INDEX.read_text(),
                                 plans_tool.render_backlog()) != INDEX.read_text():
        failures.append("INDEX.md: the generated ## Backlog section is stale "
                        "(run: tools/plans.py render-index)")

    check_links(on_disk.values(), failures)
    check_resolution_matrix(failures)
    check_inbound(failures)

    if failures:
        print(f"✗ check-plans: {len(failures)} issue(s)\n")
        for f in failures:
            print(f"  {f}")
        print("\ndocs/plans/INDEX.md is the register the tree is derived from "
              "— `tools/plans.py sync` makes the tree obey it.")
        return 1
    print(f"✓ check-plans: {len(rows)} numbered + "
          f"{len(list(BACKLOG.glob('*.md')))} backlog plans — register "
          f"consistent, links resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
