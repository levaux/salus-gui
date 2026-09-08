# @salus-gui/proto

The vendored Salus contract surface: the `.proto` sources, their generated
TypeScript, and the three hand-written modules that sit on top of them.

## What is tracked, and what is not

| Path                    | Tracked? | Why                                                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `vendor/salus/*.proto`  | yes      | The pinned upstream sources. Never hand-edit — `pnpm sync-protos` writes them.                     |
| `salus-commit.lock`     | yes      | The pin: upstream SHA + a sha256 per file. The drift gate reads this.                              |
| `.buf-image-prev.binpb` | yes      | **Recorded state**, not derivable output — the previous proto image. Losing it disarms `breaking`. |
| `src/gen/**`            | **no**   | Generated. Rebuilt by `pnpm gen`, and by this package's `postinstall` on a fresh install.          |

The rule that decides the last two rows: _generated output stays out of git;
recorded state stays in it._ `src/gen` is fully determined by the drift-gated
sources plus the pinned buf toolchain, so a committed copy could only ever rot.
The baseline image cannot be recomputed from the current tree at all — it is
what the tree used to be.

## Commands

```bash
pnpm sync-protos          # copy from ../salus and rewrite the lock (a bump)
pnpm sync-protos:check    # CI drift gate — needs no Salus checkout
pnpm gen                  # regenerate src/gen
pnpm --filter @salus-gui/proto breaking   # wire-compat vs. the baseline
```

`sync-protos` resolves its source from `$SALUS_PROTO_SRC`, else
`../salus/src/proto/Salus`. `Test/` protos are deliberately not vendored: the
console drives the regression harness by _running_ it, never by speaking its
probe protos. `EdgeControl.proto` **is** vendored despite declaring no service
yet — its messages are the control-plane contract surface.

### Bumping the pin

1. `pnpm sync-protos` against the intended Salus checkout.
2. `pnpm gen` and fix anything the new contract broke.
3. If `breaking` fails, that is the gate working: review the incompatibility
   deliberately, then regenerate the baseline **in the same commit** —
   `buf build -o .buf-image-prev.binpb`.
4. Commit as `proto:` with the new SHA in the message.

## The hand-written surface

**`well-known.ts` — the conversion choke point.** Salus `Timestamp` and
`Decimal` are `int64`-backed, which protobuf-es surfaces as `bigint`. Every
conversion lives here and none of it goes through `number`: `Number(unscaled)`
is lossy above 2^53 and rounds binary-invisibly below it. An eslint rule bans
`.unscaled` / `.scale` access everywhere else, because a Decimal read
field-by-field in a panel is how a value silently renders at the wrong scale —
and a wrong scale looks entirely plausible. Salus also carries many raw
`int64 *_us` fields, so the microsecond helpers are first-class.

**`services.ts` — the service catalog.** One entry per service; adding a
service to the console is one line. `methodsOf()` is load-bearing: protobuf-es
keys methods by camelCase **local name** (`drain`) while the wire path uses the
**proto name** (`Drain`), and routing on the key produces paths the backend
answers with UNIMPLEMENTED with no type error to warn you. `isForwardable()`
encodes decision 4 — the browser consumes unary and server-stream only, never
the Edge's `StreamHealth` / `StreamTherapy` ingest bidis.

**`mutating.ts` — the read-only guard's allow-list.** Hand-curated, because no
descriptor says whether a call changes state: `Reset` and `Drain` read like
queries and are among the most destructive here. **Over-listing is the safe
direction** — an unlisted mutator is a call read-only mode silently permits,
while an over-listed read is merely refused and immediately reported.

## Tests

`pnpm --filter @salus-gui/proto test`. Property tests (fast-check) pin the
choke point: `decFromString ∘ decToString` is the identity, no rendering is
lossy, comparison is antisymmetric across scales, and the µs round-trip holds
for pre-epoch instants (where truncating division would produce negative
`nanos` no protobuf consumer accepts). The catalog tests are drift gates: every
listed mutating RPC must still exist in the descriptors, since a gate that
matches nothing looks identical to one that works.
