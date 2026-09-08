---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git diff:*)
argument-hint: [message]
description: Create a git commit with context
---

## Context

- Current git status: !`git status`
- Current git diff: !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

Based on the above changes, create a single git commit.

If a message was provided via arguments, use it: $ARGUMENTS

Otherwise, analyze the changes and write an appropriate commit message following the
**commit subject style** in this repo (see CLAUDE.md → Git Workflow). A commit either
ships versioned product work or it doesn't, and the subject says which:

- **Versioned** (bumps the root `package.json` `"version"`): `vX.Y.Z Short description, Second change`
  - Example: `v0.1.3 Bridge Connect forward + read-only guard`
- **Non-versioned** (infra, tests, docs, tooling, config — no version bump): a **`type:` prefix**
  - One of: `docs:` · `proto:` · `test:` · `infra:` · `chore:` · `fix:`
  - Example: `chore: allowlist pnpm toolchain + document permission posture`

Never leave a non-versioned commit prefix-less, and never use a `type:` prefix on a
versioned product commit. Do NOT add `Co-Authored-By` or any contributor-attribution lines.

Keep the body terse (under ~30 lines): lead with the _what_ and the _why_; skip exhaustive
file enumeration — the diff already has those.
