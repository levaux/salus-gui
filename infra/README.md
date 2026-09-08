# infra — running the console

Four scripts, matching the platform's `infra/` conventions so an operator moving
between the two repos finds the same shapes: `-q/--quiet` everywhere, `-h/--help`
on each, coloured ✓/✗/⊘, and errors that name the command that fixes them.

The console's "infrastructure" is a couple of Node processes rather than
containers, so these are PID- and port-based where the platform's are
docker-based. PIDs and logs land in `infra/run/` (gitignored).

## The two modes

Everything hinges on **which fleet the bridge talks to**.

```bash
./infra/up.sh              # mock mode (default): mock fleet + bridge → mock
./infra/up.sh --live       # live mode: bridge → a real Salus fleet
```

**Mock mode is fully offline.** No Salus checkout, no Postgres, no Envoy, no
build of the platform. The mock binds one listener per service
(`56800, 56810 … 56850`) so the bridge's per-service rebasing reaches all of
them, and the fleet it presents is deterministic from a seed.

**Live mode** points the bridge at a real fleet on its documented ports and
starts no mock. Bring the platform up first:

```bash
../salus/infra/db/up.sh && ../salus/infra/envoy/up.sh
# then run the services you need from ../salus/bin/
./infra/up.sh --live
```

If nothing is listening on `:57000`, `up.sh --live` still starts the bridge but
says so plainly — otherwise the first symptom is a panel reporting `UNAVAILABLE`
with no explanation.

## The scripts

| Script      | What it does                                                        |
| ----------- | ------------------------------------------------------------------- |
| `up.sh`     | Start the stack. Idempotent — a component already up is left alone. |
| `down.sh`   | Stop what `up.sh` started, by PID file.                             |
| `status.sh` | Console processes **and** the platform ports behind them.           |
| `logs.sh`   | Read or follow a component's log.                                   |

### Options

```bash
./infra/up.sh --only mock          # just the mock (repeatable: --only bridge)
./infra/up.sh --read-only          # bridge refuses every mutating RPC
./infra/up.sh --live --host 10.0.0.5
./infra/up.sh -q                   # quiet; errors still print

./infra/down.sh --only bridge
./infra/down.sh --force            # free the ports even without a PID file

./infra/status.sh                  # exit 0 when the console stack is up, 1 otherwise
./infra/logs.sh bridge -f          # follow
./infra/logs.sh mock -n 200
```

Ports come from `BRIDGE_PORT` / `MOCK_PORT`; `SALUS_ROOT` points at the platform
checkout when it is not `../salus`.

`--force` is for the case `up.sh` refuses to start because a port is held by a
process it does not own — a `pnpm dev:bridge` run by hand, or an orphan from a
crash. It kills by port, so use it knowing that.

## First run

```bash
pnpm install                                # also generates the proto code
pnpm --filter @salus-gui/bridge cert        # once — TLS is mandatory, see below
./infra/up.sh
curl -sk --http2 https://localhost:56400/bridge/info
```

`up.sh` checks all three prerequisites (Node ≥ 22 + pnpm + `node_modules`,
generated codegen, a bridge certificate) and fails with the fix command rather
than letting a component exit cryptically after another has already started.

**Why a certificate is required:** browsers only multiplex HTTP/2 over TLS, and
without multiplexing a workspace's live streams starve the ~6 connections a
browser allows per origin — panels _hang_ rather than fail. The bridge refuses
to start rather than appear to work until the sixth stream. `mkcert` is
preferred (trusted local CA, no browser warning); the script falls back to
self-signed openssl, which is identical on the wire.

## Three things learned writing these

Recorded because each was a real defect, not a hypothetical:

- **No `( cmd & echo $! )` subshell.** Inside one, `$!` names the subshell's
  fork rather than the server, so the PID file pointed at a forked copy of
  `up.sh` and stopping a component stopped nothing.
- **`</dev/null` on the detached child.** A child holding the caller's stdin
  keeps the invoking shell (or a CI step) waiting for a process that never
  exits — `up.sh` hung indefinitely despite the stack being up.
- **Stop by PID tree, never by process group.** `pnpm dev:X` spawns node, so
  signalling only the recorded pid leaves the server holding its port — but
  these children share a process group with the calling shell, so
  `kill -- -PGID` takes down the caller too. It did.
