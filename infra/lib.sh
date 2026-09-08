#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# salus-gui — shared helpers for the infra scripts.
#
# Sourced by up.sh / down.sh / status.sh / logs.sh. Not executable on its own.
#
# The console's "infrastructure" is a couple of Node processes rather than
# containers, so this is PID- and port-based where the platform's equivalents
# are docker-based. The conventions (palette, -q/--quiet, -h/--help extracted
# from the header, actionable errors) deliberately match the platform's
# infra/envoy and infra/db scripts, because an operator moves between them.
# -----------------------------------------------------------------------------

# Repo root, however the caller invoked us.
GUI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$GUI_ROOT/infra/run"

# Everything below assumes the repo root, so the component commands (`pnpm …`)
# resolve the workspace regardless of where the operator invoked the script.
# Done once here rather than in a per-start subshell — see start_component.
cd "$GUI_ROOT"

# Where a real Salus checkout is expected, for --live and for status reporting.
SALUS_ROOT="${SALUS_ROOT:-$(cd "$GUI_ROOT/.." && pwd)/salus}"

# The console's own ports, outside the platform's 57xxx/58xxx bands.
BRIDGE_PORT_DEFAULT=56400
MOCK_PORT_DEFAULT=56800
WEB_PORT_DEFAULT=5173

# -----------------------------------------------------------------------------
# Colour palette — matches the platform's scripts so the two read alike.
# -----------------------------------------------------------------------------
if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'
    LGREEN=$'\033[1;32m'; LRED=$'\033[1;31m'; LYELLOW=$'\033[1;33m'
    CYAN=$'\033[0;36m';  RESET=$'\033[0m'
else
    BOLD=''; DIM=''; LGREEN=''; LRED=''; LYELLOW=''; CYAN=''; RESET=''
fi

QUIET=${QUIET:-0}
log()  { [[ $QUIET -eq 1 ]] || echo -e "${CYAN}==>${RESET} $*"; }
ok()   { [[ $QUIET -eq 1 ]] || echo -e "${LGREEN}✓${RESET} $*"; }
warn() { [[ $QUIET -eq 1 ]] || echo -e "${LYELLOW}⚠${RESET} $*"; }
err()  { echo -e "${LRED}${BOLD}✗${RESET} $*" >&2; }

# Print the script's own header block as help.
show_help() {
    sed -n '2,/^# ----/p' "$1" | sed -e 's/^# \{0,1\}//' -e '/^----/d'
    exit 0
}

# -----------------------------------------------------------------------------
# Process bookkeeping
# -----------------------------------------------------------------------------
pid_file() { echo "$RUN_DIR/$1.pid"; }
log_file() { echo "$RUN_DIR/$1.log"; }

# Is this component running, per its PID file?
is_running() {
    local name="$1" pf
    pf="$(pid_file "$name")"
    [[ -f "$pf" ]] || return 1
    local pid
    pid="$(cat "$pf" 2>/dev/null)"
    [[ -n "$pid" ]] || return 1
    kill -0 "$pid" 2>/dev/null
}

running_pid() { cat "$(pid_file "$1")" 2>/dev/null; }

# Is anything listening on this TCP port?
port_open() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti ":$port" >/dev/null 2>&1
    else
        # Fall back to a connect attempt; bash's /dev/tcp needs no extra tool.
        (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
    fi
}

# Wait until `port_open` succeeds, or give up. Returns 1 on timeout.
wait_for_port() {
    local port="$1" secs="${2:-30}" name="${3:-service}"
    local deadline=$(( $(date +%s) + secs ))
    while ! port_open "$port"; do
        if (( $(date +%s) > deadline )); then
            err "timed out after ${secs}s waiting for $name on :$port"
            return 1
        fi
        sleep 0.3
    done
    return 0
}

# Start a component in the background, recording its PID and log.
# start_component <name> <port> <readiness-secs> <command...>
start_component() {
    local name="$1" port="$2" secs="$3"; shift 3
    mkdir -p "$RUN_DIR"

    if is_running "$name"; then
        ok "$name already running (pid $(running_pid "$name"))"
        return 0
    fi
    if port_open "$port"; then
        err "$name port :$port is already in use by something this script did not start."
        err "    find it:  lsof -i :$port"
        err "    free it:  lsof -ti :$port | xargs kill"
        return 1
    fi

    local lf; lf="$(log_file "$name")"
    log "Starting $name (:$port)..."

    # Start it detached, and record the pid of the thing we actually started.
    #
    # Three details, each of which was a bug before it was a line of code:
    #   • No `( … & echo $! )` subshell wrapper. Inside one, `$!` names the
    #     subshell's fork rather than the server, so the PID file pointed at a
    #     forked copy of this script — and stopping "the component" stopped
    #     nothing. The scripts cd to GUI_ROOT once at load instead.
    #   • `</dev/null`, so a detached child does not hold the caller's stdin
    #     and leave the invoking shell (or a CI step) waiting forever.
    #   • `disown`, so this script owes the job nothing and can exit at once.
    nohup "$@" >"$lf" 2>&1 </dev/null &
    local child=$!
    disown "$child" 2>/dev/null || true
    echo "$child" >"$(pid_file "$name")"

    if ! wait_for_port "$port" "$secs" "$name"; then
        err "last 20 lines of $lf:"
        tail -20 "$lf" >&2 || true
        stop_component "$name" >/dev/null 2>&1 || true
        return 1
    fi
    ok "$name  ${DIM}:$port${RESET}  ${DIM}(pid $(running_pid "$name"), log infra/run/$name.log)${RESET}"
}

# Every descendant of a pid, deepest first — so children die before parents and
# nothing gets re-parented and orphaned mid-teardown.
pid_tree() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        pid_tree "$child"
    done
    echo "$pid"
}

# Stop a component: TERM the whole tree, then KILL what is left.
#
# By PID tree, deliberately NOT by process group. `pnpm dev:X` spawns node, so
# signalling only the recorded pid leaves the real server holding its port —
# but these children share their process group with this script and the shell
# that ran it, so `kill -- -PGID` takes down the caller too. That is not
# theoretical: it killed the invoking shell the first time this was written.
stop_component() {
    local name="$1"
    if ! is_running "$name"; then
        rm -f "$(pid_file "$name")"
        return 1
    fi
    local pid; pid="$(running_pid "$name")"
    log "Stopping $name (pid $pid)..."

    local tree; tree="$(pid_tree "$pid")"
    for p in $tree; do kill -TERM "$p" 2>/dev/null || true; done

    local deadline=$(( $(date +%s) + 8 ))
    while kill -0 "$pid" 2>/dev/null; do
        if (( $(date +%s) > deadline )); then
            warn "$name did not stop on TERM — sending KILL"
            for p in $tree; do kill -KILL "$p" 2>/dev/null || true; done
            break
        fi
        sleep 0.2
    done
    rm -f "$(pid_file "$name")"
    ok "$name stopped"
}

# -----------------------------------------------------------------------------
# Preflight
# -----------------------------------------------------------------------------
require_toolchain() {
    if ! command -v node >/dev/null 2>&1; then
        err "node not found. This repo needs Node >= 22:"
        err "    brew install node    (or use nvm: nvm use)"
        exit 1
    fi
    local major; major="$(node -p 'process.versions.node.split(".")[0]')"
    if (( major < 22 )); then
        err "node $major is too old — this repo needs >= 22 (see .nvmrc)"
        exit 1
    fi
    if ! command -v pnpm >/dev/null 2>&1; then
        err "pnpm not found:"
        err "    corepack enable    (pnpm version is pinned in package.json)"
        exit 1
    fi
    if [[ ! -d "$GUI_ROOT/node_modules" ]]; then
        err "dependencies are not installed:"
        err "    pnpm install"
        exit 1
    fi
}

# The bridge refuses to start without TLS — fail here with the fix rather than
# letting it exit cryptically after we have already started the mock.
require_cert() {
    if [[ ! -f "$GUI_ROOT/apps/bridge/certs/bridge.pem" ]]; then
        err "no bridge TLS certificate."
        err "Browsers only multiplex HTTP/2 over TLS, so the bridge requires one."
        err "    pnpm --filter @salus-gui/bridge cert"
        exit 1
    fi
}

# Generated proto code is not committed; without it nothing typechecks or runs.
require_codegen() {
    if [[ ! -d "$GUI_ROOT/packages/proto/src/gen" ]]; then
        err "proto codegen is missing (it is generated, not committed):"
        err "    pnpm gen        # or just: pnpm install"
        exit 1
    fi
}
