---
description: Clean up code, stage changes, and prepare a pull request
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(pnpm:*)
---

# Pull Request Preparation Checklist

Before creating a PR, execute these steps:

1. **Proto gates**: `pnpm sync-protos:check` (vendored protos match the commit lock), then
   `pnpm gen` and confirm `git diff --exit-code -- packages/proto/src/gen` is clean (committed
   codegen matches the vendored protos).
2. **Lint**: `pnpm lint` (eslint + prettier --check); fix everything it reports.
3. **Typecheck**: `pnpm typecheck` (tsc -b across every project reference).
4. **Run tests**: `pnpm test` (vitest across packages and apps).
5. **Build**: `pnpm build` (packages → web → bridge, in dependency order).
6. **Review diff**: `git diff main...HEAD`
7. **Stage changes**: add only relevant source files — avoid `dist/`, `build/`, `.svelte-kit/`,
   `node_modules/`, local certs.
8. **Commit message**: follow the repo style (CLAUDE.md → Git Workflow)
   - Versioned: `vX.Y.Z Description, Second change` (bumps the root `package.json` `"version"`)
   - Non-versioned: `<type>: short description` (`docs:`/`proto:`/`test:`/`infra:`/`chore:`/`fix:`)
   - No `Co-Authored-By` / attribution lines.

9. **PR summary should include**:
   - What changed and why
   - Which apps / packages are affected
   - Test results (which suites ran, pass/fail)
   - Any vendored-proto changes (which upstream commit the lock now pins, breaking or additive)
