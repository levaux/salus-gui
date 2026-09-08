#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# salus-gui — start the console stack.
#
# Two modes, and the choice is which fleet the bridge talks to:
#
#   --mock   (default)  the deterministic mock fleet + the bridge pointed at it.
#                       Fully offline: no Salus checkout, no database, no Envoy.
#   --live              the bridge pointed at a real Salus fleet on its
#                       documented ports. Start the platform first (see below);
#                       no mock is run.
#
# Safe to run repeatedly: a component already running is left alone.
#
# Usage:
#   ./infra/up.sh                    # mock fleet + bridge
#   ./infra/up.sh --live             # bridge → a real fleet on 127.0.0.1
#   ./infra/up.sh --live --host h    # bridge → a fleet on another host
#   ./infra/up.sh --only mock        # just the mock
#   ./infra/up.sh --read-only        # bridge refuses every mutating RPC
#
# Flags:
#   --mock              use the mock fleet (default)
#   --live              use a real Salus fleet; implies --only bridge
#   --host <host>       host for --live (default 127.0.0.1)
#   --only <component>  one of: mock, bridge  (repeatable)
#   --read-only         start the bridge with the read-only switch on
#   -q, --quiet         suppress progress output (still prints errors)
#   -h, --help          this text
#
# For --live, bring the platform up first:
#   ../salus/infra/db/up.sh && ../salus/infra/envoy/up.sh
#   then run the services you need from ../salus/bin/
#
# Exit: 0 when every requested component is listening, 1 otherwise.
# -----------------------------------------------------------------------------

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE=mock
HOST=127.0.0.1
READ_ONLY=0
ONLY=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mock)      MODE=mock ;;
        --live)      MODE=live ;;
        --host)      HOST="${2:?--host needs a value}"; shift ;;
        --only)      ONLY+=("${2:?--only needs a component}"); shift ;;
        --read-only) READ_ONLY=1 ;;
        -q|--quiet)  QUIET=1 ;;
        -h|--help)   show_help "${BASH_SOURCE[0]}" ;;
        *) err "unknown option: $1"; err "try: $0 --help"; exit 2 ;;
    esac
    shift
done

# --live means there is no mock to start.
if [[ $MODE == live && ${#ONLY[@]} -eq 0 ]]; then ONLY=(bridge); fi
if [[ ${#ONLY[@]} -eq 0 ]]; then ONLY=(mock bridge); fi

wants() { local c; for c in "${ONLY[@]}"; do [[ "$c" == "$1" ]] && return 0; done; return 1; }

for c in "${ONLY[@]}"; do
    case "$c" in
        mock|bridge) ;;
        *) err "unknown component '$c' (expected: mock, bridge)"; exit 2 ;;
    esac
done

require_toolchain
require_codegen
wants bridge && require_cert

# -----------------------------------------------------------------------------
# Mock fleet
# -----------------------------------------------------------------------------
if wants mock; then
    if [[ $MODE == live ]]; then
        warn "--live and --only mock together: starting the mock, but the bridge"
        warn "  would not use it. Did you mean ./infra/up.sh (mock mode)?"
    fi
    MOCK_PORT="${MOCK_PORT:-$MOCK_PORT_DEFAULT}" \
        start_component mock "${MOCK_PORT:-$MOCK_PORT_DEFAULT}" 30 pnpm dev:mock
fi

# -----------------------------------------------------------------------------
# Bridge
# -----------------------------------------------------------------------------
if wants bridge; then
    if [[ $MODE == live ]]; then
        BRIDGE_SITE=dev-local
        # A live fleet has to actually be there. Check Network's port and say
        # so plainly rather than leaving the operator to read ECONNREFUSED out
        # of a panel later.
        if ! port_open 57000; then
            warn "nothing is listening on $HOST:57000 (the Network service)."
            warn "  The bridge will start, but every panel will report UNAVAILABLE."
            warn "  Start the platform:  $SALUS_ROOT/infra/db/up.sh && $SALUS_ROOT/infra/envoy/up.sh"
            warn "  then run the services you need from $SALUS_ROOT/bin/"
        fi
    else
        BRIDGE_SITE=dev-mock
        if ! wants mock && ! port_open "${MOCK_PORT:-$MOCK_PORT_DEFAULT}"; then
            warn "mock mode, but no mock is running on :${MOCK_PORT:-$MOCK_PORT_DEFAULT}."
            warn "  Start it:  ./infra/up.sh --only mock"
        fi
    fi

    BRIDGE_SITE="$BRIDGE_SITE" \
    BRIDGE_PORT="${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}" \
        start_component bridge "${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}" 30 pnpm dev:bridge

    if [[ $READ_ONLY -eq 1 ]]; then
        log "Enabling read-only mode..."
        curl -sk --http2 -X PUT \
            "https://localhost:${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}/bridge/readonly" \
            -H 'content-type: application/json' -d '{"readOnly":true}' >/dev/null
        ok "read-only ${BOLD}on${RESET} — every mutating RPC is refused"
    fi
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
if [[ $QUIET -eq 0 ]]; then
    echo
    if [[ $MODE == live ]]; then
        ok "Bridge     ${DIM}https://localhost:${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}${RESET}  → live fleet at ${HOST}"
    else
        ok "Mock fleet ${DIM}h2c :${MOCK_PORT:-$MOCK_PORT_DEFAULT}…${RESET}  (one listener per service)"
        ok "Bridge     ${DIM}https://localhost:${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}${RESET}  → mock"
    fi
    echo
    log "Check it:    ${BOLD}curl -sk --http2 https://localhost:${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}/bridge/info${RESET}"
    log "Status:      ${BOLD}./infra/status.sh${RESET}"
    log "Logs:        ${BOLD}./infra/logs.sh bridge -f${RESET}"
    log "Stop:        ${BOLD}./infra/down.sh${RESET}"
fi
