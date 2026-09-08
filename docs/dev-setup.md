# Development setup

Getting from a fresh clone to a running console, and the handful of things about this repo that
are surprising the first time. Operating the stack once it runs — every flag, both modes,
troubleshooting a held port — lives in [infra/README.md](../infra/README.md); this page gets you
to the point where that one applies.

## Prerequisites

| Need     | Version         | Notes                                                                                       |
| -------- | --------------- | ------------------------------------------------------------------------------------------- |
| Node     | ≥ 22 (`.nvmrc`) | `nvm use` picks it up.                                                                      |
| pnpm     | 9.15.0          | Do not install it by hand — `corepack enable` pins the exact version from `packageManager`. |
| Python 3 | any stdlib 3    | The plans tooling only. No venv, no requirements file, by design.                           |
| mkcert   | optional        | Preferred for the bridge's TLS certificate; the script falls back to self-signed openssl.   |

Nothing else is global. `buf` and `protoc-gen-es` arrive as npm dependencies, so codegen needs no
system toolchain, and the Salus platform checkout is **not** required for any of the above.

## First run

```bash
corepack enable
pnpm install                              # also generates the proto code — see below
pnpm --filter @salus-gui/bridge cert      # once; the bridge refuses to start without TLS
./infra/up.sh                             # mock fleet + bridge + SPA, fully offline
```

Then open <http://localhost:5173>. Stop with `./infra/down.sh`.

`up.sh` checks all three prerequisites up front and fails naming the command that fixes it,
rather than letting one component exit cryptically after another has already started.

## Two things that surprise people

**Generated code is not in git, so `pnpm install` comes before anything else.** `packages/proto/src/gen/`
is produced by `buf generate` from the vendored protos, and the proto package's `postinstall`
runs it. A tree that has been cloned but not installed does not typecheck, and the error is a
wall of missing modules rather than anything pointing at the cause. This is deliberate: the
generated output is fully determined by the drift-gated vendored sources plus a pinned toolchain,
so there is nothing to review in a diff of it. Regenerate by hand with `pnpm gen`.

The mirror-image rule: `packages/proto/.buf-image-prev.binpb` **is** committed. It is the
baseline the wire-compatibility gate compares against — recorded state, not derivable from the
tree — and deleting it silently disarms the gate rather than breaking it.

**TLS on the bridge is mandatory, not a hardening step.** Browsers only multiplex HTTP/2 over
TLS, and without multiplexing a workspace's live streams starve the roughly six connections a
browser allows per origin. The failure mode is panels that _hang_ rather than fail, from the
sixth stream onward. The bridge refuses to start without a certificate instead of appearing to
work up to that point.

## Running against a real fleet

Mock mode needs no Salus checkout at all. To point at the real thing, bring the platform up
first, then start the bridge in live mode:

```bash
../salus/infra/db/up.sh && ../salus/infra/envoy/up.sh
# start the services you need from ../salus/bin/
./infra/up.sh --live
```

The same console code talks to both — that is the point of the mock, and the reason the mock is
served over a real socket by the same Connect adapter the bridge dials in production. `SALUS_ROOT`
points at the platform checkout when it is not `../salus`.

If a workspace grows past a few simultaneous live feeds, add `--direct`: the SPA then calls the
bridge over one h2 connection instead of through Vite's HTTP/1.1 proxy, which hits the same
per-origin ceiling described above.

## The gates

```bash
pnpm lint && pnpm typecheck && pnpm check && pnpm test && pnpm build
```

`pnpm check` is svelte-check, and it is **not** redundant with `pnpm typecheck`: `tsc` cannot
parse `.svelte` template syntax at all, so a wrong proto field path inside a component is
invisible to every other gate and renders as silently nothing.

Two proto-specific gates run in CI and are worth running locally after a proto bump:
`pnpm sync-protos:check` (the vendored copies match `salus-commit.lock`) and
`pnpm --filter @salus-gui/proto breaking` (wire compatibility against the committed baseline).

**Chain gates with `&&` and never pipe one.** `set -e` does not abort in every shell this repo is
driven from, and a pipe hands you the pipeline's exit code rather than the gate's — either way a
failure reads as a pass. If you want short output, redirect to a file and read it after the `&&`.

## Repo tooling

```bash
pnpm plans render-index      # regenerate the Backlog section of docs/plans/INDEX.md
pnpm plans sync              # make the tree obey INDEX.md after editing a plan's row
pnpm plans:lint              # register consistency + link integrity
```

Never move a plan file by hand. Inbound references accumulate across the tree, and `sync` rewrites
every one of them — markdown link targets and bare path strings — in the same pass.
