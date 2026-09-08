# @salus-gui/streams

The console's data layer. **Framework-lean by design** — no reactivity
primitives anywhere in this package — so the same code runs in the browser
behind a thin reactive view, in the bridge, and in vitest under injected
clocks. Every timer, clock and random source is injectable, which is why the
contracts below are pinned by fast unit tests rather than by clicking around.

## The three reconnect contracts

A console that reconnects badly is worse than one that does not reconnect at
all: it shows stale rows with a green badge. These three contracts are the
answer, and each has a different reason for existing.

### SeqResume — logs and lifecycle

`Salus.Admin.LogEntry` and `Salus.Network.AggregatedLogEntry` carry a monotonic
`seq`, and the services replay from a requested one. `StreamController`'s
`resumeHeaders(lastMsg)` returns `salus-log-since-seq` (or
`salus-lifecycle-since-seq`) built from the last message seen, so a reconnect
resumes at exactly the right point — no duplicates, no gap, no snapshot needed.

The bridge forwards request headers **verbatim**, which is precisely why the
mechanism is a header rather than a request field: resume works with zero
bridge special-casing.

### Resnapshot — rosters, registries, active-session tables

Feeds with no resumable sequence (the service registry, the session roster, the
active-therapy registry) must re-read their authority on every reconnect.
Re-opening the delta stream alone is not enough: whatever changed while
disconnected is gone, and the table would keep showing rows that no longer
exist.

The ordering is **subscribe-then-snapshot**, which is the whole point:

1. open the delta stream → the service queues deltas from here
2. fetch the snapshot (`onConnected`) → authoritative state up to "now"
3. `applySnapshot(rows)` → seed the table, **evict** keys the snapshot lacks
4. drain queued + live deltas → applied on top, idempotent by key

No delta can be lost between (1) and (2) because the stream is already open when
the snapshot is taken. Snapshot-then-subscribe leaves exactly that gap, and the
resulting row stays wrong for as long as the panel is open.

A snapshot that throws fails the whole connection and retries, rather than
seeding a table from a partial read.

### Linger — navigation should not re-snapshot

`StoreRegistry` ref-counts acquisition. The feed starts on the first acquire;
when the last holder releases, the stop **lingers** (45 s default), and
re-acquiring inside that window cancels it and reuses the live streams.

The cost is asymmetric: streams are multiplexed over one h2 connection, so an
idle lingering stream is nearly free, while a re-snapshot costs an authoritative
read per table plus the reconcile. Tearing down on every navigation trades
something free for something expensive, and the operator sees it as a flicker on
every screen change. `lingerMs: 0` restores immediate teardown.

## Keyed keep-latest is also the ClickHouse dedup

Salus's Health and Therapy data tables are **`ReplacingMergeTree` keyed by
`event_id`**, and the query surfaces read them without `FINAL`. Between a
re-write and the background merge, a query legitimately returns more than one
row per `event_id`.

`ConflatedTable` keyed by `event_id` collapses those duplicates to the latest,
matching the table's own replace semantics exactly. Key it by anything else — or
push rows into a list — and you get double-counted series, double-drawn curves,
and, in a keyed template, a duplicate-key error that aborts a render flush and
freezes the surrounding UI. Append-only display feeds whose ordering is
service-owned should use positional keys and not claim an identity they lack.

## What is here

| Module                  | What it does                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport.ts`          | The **only** transport constructor. Binary format (int64 stays bigint), unload-aborting fetch, fatal-vs-retryable classification, and the metadata key constants. |
| `stream-controller.ts`  | `idle → connecting → live → backoff → (live \| fatal)` with jittered backoff and resume headers.                                                                  |
| `conflated-table.ts`    | Keyed keep-latest with a ~16 ms flush, grid + mirror-map sinks, and `applySnapshot` reconcile.                                                                    |
| `resnapshot.ts`         | `bindResnapshot` — the subscribe-then-snapshot wiring.                                                                                                            |
| `store-registry.ts`     | Ref-counted acquisition with linger.                                                                                                                              |
| `ring-buffer.ts`        | Fixed-capacity FIFO for logs and harness output.                                                                                                                  |
| `series-buffer.ts`      | Columnar `Float64Array` ring for metric series, zero per-frame allocation.                                                                                        |
| `connection-manager.ts` | Health probe + mass-resubscribe on recovery.                                                                                                                      |

## Two details worth knowing

**`isFatalConnectError` treats `PERMISSION_DENIED` as permanent**, because that
is the shape a **Session ejection** takes: the JWT still verifies
cryptographically, but `ext_authz` refuses at the edge. Retrying spins against a
decision already made, so the panel must say _fatal_ rather than sit in backoff
looking merely unlucky.

**Backoff jitter is not decoration.** Without it, every panel in a workspace
that dropped together retries in lockstep and hammers the service it is waiting
on. The tests assert the spread, not just the growth and the cap.
