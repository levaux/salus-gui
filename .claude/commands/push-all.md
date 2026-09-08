---
description: Stage all changes, create commit, and push to remote (use with caution)
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git push:*), Bash(git diff:*), Bash(git log:*), Bash(git pull:*)
---

# Commit and Push Everything

⚠️ **CAUTION**: Stage ALL changes, commit, and push to remote. Use only when confident all
changes belong together.

## Workflow

### 1. Analyze Changes

Run in parallel:

- `git status` — show modified/added/deleted/untracked files
- `git diff --stat` — show change statistics
- `git log -1 --oneline` — show recent commit for message style

### 2. Safety Checks

**❌ STOP and WARN if detected:**

- Build output: `dist/`, `build/`, `.svelte-kit/`, `*.tsbuildinfo`, `node_modules/`
- Local secrets/state: `apps/bridge/certs/`, `*.pem`, `.env*`, `apps/bridge/kv/`, `apps/bridge/audit/`
- Stale codegen: `packages/proto/src/gen/` differing from what `pnpm gen` produces, or
  `packages/proto/vendor/` edited outside `pnpm sync-protos`
- Temp/editor files: `.DS_Store`, `__pycache__/`, `*.swp`, `*.tmp`
- Large binaries: files >5MB that aren't intentionally vendored

**✅ Verify:**

- No merge conflicts
- Correct branch (warn if pushing directly to `main`)

### 3. Request Confirmation

Present summary:

```
Changes Summary:
- X files modified, Y added, Z deleted
- Total: +AAA insertions, -BBB deletions

Safety: ✅ No build output | ✅ No stale codegen | ⚠️ [warnings if any]
Branch: [name] → origin/[name]

I will: git add <files> → commit → push

Type 'yes' to proceed or 'no' to cancel.
```

**WAIT for explicit "yes" before proceeding.**

### 4. Execute (After Confirmation)

Stage source files explicitly — never `git add -A` (parallel sessions can share the tree):

```bash
git add packages/ apps/ tools/ docs/ README.md CLAUDE.md .gitignore
git status  # verify staging looks correct
```

### 5. Generate Commit Message

Follow this repo's commit style (CLAUDE.md → Git Workflow):

- **Versioned** (bumps root `package.json` `"version"`): `vX.Y.Z Description, Second change`
- **Non-versioned**: `<type>: short description` (`docs:`/`proto:`/`test:`/`infra:`/`chore:`/`fix:`)
- No `Co-Authored-By` / attribution lines.

### 6. Commit and Push

```bash
git commit -m "$(cat <<'EOF'
[Generated commit message]
EOF
)"
git push  # If fails: git pull --rebase && git push
git log -1 --oneline --decorate  # Verify
```
