# @salus-gui/bridge — `salus-bridged`

The browser's only counterparty. One process on `:56400` serving three things
over a single h2/TLS connection:

| Path        | What it is                                            |
| ----------- | ----------------------------------------------------- |
| `/rpc/*`    | Connect ⇄ gRPC forward to the Salus fleet             |
| `/kv/*`     | bridge-local document store (workspaces, saved views) |
| `/bridge/*` | bridge-local control: `info`, `audit`, `readonly`     |

```bash
pnpm --filter @salus-gui/bridge cert   # once — mkcert if installed, else openssl
pnpm dev:bridge                        # BRIDGE_PORT / BRIDGE_SITE override
```

## Why TLS is mandatory

Browsers only multiplex HTTP/2 over TLS. Without it a workspace's twenty-plus
live streams starve the ~6 connections a browser allows per origin over
HTTP/1.1 — and the failure mode is panels that _hang_ rather than fail, which
is worse than an error. So the bridge refuses to start without a certificate
instead of falling back to something that appears to work until the sixth
stream. `SETTINGS_MAX_CONCURRENT_STREAMS` is raised to 256 for the same reason.

## The forward

`forwardService` walks each catalog entry's method descriptors and wires them
onto the router: unary awaits `transport.unary`, server-streaming pipes
`transport.stream`. **Client- and bidi-streaming are skipped by rule** — the
only ones in the Salus catalog are the Edge's acknowledged ingest sessions
(`StreamHealth`, `StreamTherapy`) and `PushNetworkStats`. Forwarding one would
mean the bridge originates an ingest session _to_ the platform on a browser's
behalf, claiming to be an Edge. The console observes their effects through the
query and subscribe surfaces instead.

**Request headers cross verbatim.** That is what makes `salus-log-since-seq`
resume work with no special-casing here, and what will carry an `Authorization`
bearer unchanged when the token workbench lands. Only two sets are stripped:
connection-specific headers HTTP/2 forbids (Node's client rejects them
outright), and framing/codec headers the upstream transport sets for itself.
Response headers come back the same way, minus gRPC framing — copying the
upstream `content-type: application/grpc` would clobber the Connect one and the
browser would reject its own response.

## Three guards

**Read-only.** One flip refuses every mutating RPC across the site with
`FAILED_PRECONDITION`, before the call reaches the fleet. Reads keep working —
the switch makes the console observe-only, not useless. The flip is itself
audited.

**Not an open proxy.** `salus-admin-target` names an address the browser
supplies, so it is validated as `host:port` and the host is pinned to the
site's host or loopback. Without that pin, anything that can reach the console
could dial arbitrary hosts through the bridge. A loopback address is rewritten
to the site host and rebased like the catalog transports — a service registers
the address _it_ binds, which from a remote bridge is the bridge's own box.

**KV names cannot traverse.** Namespace and key must match
`[A-Za-z0-9_-]{1,64}`, which admits no separator and no dot, so `..` is
unrepresentable rather than filtered. (The URL parser normalises most attempts
away before they ever reach the handler; the charset is the second guard.)

## Client disconnect is routine

Browsers reset h2 streams on every reload, tab close, HMR update and
sleep-wake — as `CANCEL` or `INTERNAL_ERROR`, or as `missing status` when the
client vanished before trailers. `isClientDisconnect` classifies these and logs
**one quiet line, no stack**. A reload resets every open stream at once, so
logging each as an error turns one reload into a hundred lines and buries the
real faults. Anything else keeps its stack.

## Sites

`sites.json` names each backend. `portBase` rebases the whole catalog
(`port = portBase + (catalogPort - 57000)`) onto the mock's rebased set; omit it
to talk to a real fleet on its documented ports. `BRIDGE_SITE` picks one.

## Tests

`pnpm --filter @salus-gui/bridge test` — 40 tests. The unit suites cover each
guard in isolation; `integration.test.ts` runs the whole path on a real socket
(Connect client → bridge over h2/TLS → mock fleet over h2c gRPC) and is the one
that proves header hygiene, transport re-encoding, per-Component routing,
streaming and the read-only switch work _together_. Async assertions await real
completion — a fake that resolves when the handler calls `end` — never a sleep,
because a fixed timeout passes locally and flakes on a slow runner.

## Not here yet

Static serving of the built SPA lands with `apps/web` (v0.1.6): there is no
build directory to serve. The `/harness` and `/infra` surfaces are plan 002.
