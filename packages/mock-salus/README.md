# @salus-gui/mock-salus

A deterministic double of the Salus fleet: one h2c Connect hub answering the
service catalog, so the console runs fully offline and the same code connects to
a real fleet unchanged.

```bash
pnpm dev:mock                       # hub on :56800
MOCK_PORT=7000 MOCK_SEED=x pnpm dev:mock
```

## Why one listener

The bridge rebases every catalog port onto this hub
(`port = portBase + (catalogPort - 57000)`), so a single process answers
Network, Admin, Session and the rest. `connectNodeAdapter` serves the Connect,
gRPC **and** gRPC-Web wire protocols on the same routes, which is what lets the
bridge's real `createGrpcTransport` talk to this mock unmodified — pointing a
site at the mock or at a live fleet is a host/port change and nothing else.

That claim is tested over a real socket with a real gRPC client
(`server.test.ts`), not just in-process: a mock that only ever answered
in-process calls could be wrong on the wire in ways no unit test would see.

## Two rules this package is built on

**Deterministic by construction.** Every value is a pure function of
`(seed, service, tick)` — never of a clock or `Math.random`. The same seed
produces byte-identical output on every run and every machine, and a window
slice is independent of how it was reached. That is the discipline Salus's own
`SalusHealth` simulator holds to, and it is what lets tests assert exact frames
instead of "roughly a number". A mock that drifts between runs gets asserted
_around_ rather than against, which is how a suite stops noticing things.

**The mock's world follows the request.** Every handler reads what was actually
asked and answers accordingly:

| The request carries   | The mock honours it by                                     |
| --------------------- | ---------------------------------------------------------- |
| `salus-admin-target`  | answering for **that** Component (Admin is on all of them) |
| `salus-log-since-seq` | replaying strictly `seq > since` — no duplicate, no gap    |
| `include_closed`      | filtering revoked sessions out when it is false            |
| an unknown target     | `NOT_FOUND`, never a fabricated healthy row                |

A double that ignores its request looks plausible offline and disagrees with the
real fleet in the way hardest to diagnose: an empty panel, or one showing
something real but not what was asked for.

## What it does _not_ do

Health, Therapy and Protocol are **not** doubled yet; they land with the panels
that consume them (`v0.2.5`, `v0.2.6`). Inventing query shapes before a consumer
exists would produce fixtures shaped by guesswork — the same failure the rule
above exists to prevent. The generator and the request-following helpers are
here, so each addition is small.

## Deliberate details

- **The fleet is not all green.** The seeded status roll leaves at least one
  service DEGRADED or STARTING, because a console only ever seen against a
  healthy fleet has never shown its operator what trouble looks like.
- **Mutations are observable.** Ejecting a session flips its row to `ERROR`
  (an operator did that on purpose — distinct from an expiry's `STOPPED`) and
  removes it from the open roster; draining a service shows up in the registry.
  A mock where a mutating call returns OK and changes nothing lets a panel look
  correct while proving nothing.
- **Re-ejecting revokes nothing** and says so, which is what an idempotent
  operator action should report.
- **Streams stay open after their backlog.** A log stream that ended when it ran
  out of history would make every console panel reconnect in a loop.
- **`registered` services carry `(unauthenticated)`** as their subject — the
  exact literal the platform writes when registration did not pass the
  JWT-enforcing edge.
