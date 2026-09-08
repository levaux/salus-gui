#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# salus-gui — stop the console stack.
#
# Stops what this repo's up.sh started, by PID file. Safe to run repeatedly and
# safe to run when nothing is up.
#
# Usage:
#   ./infra/down.sh                  # stop everything
#   ./infra/down.sh --only bridge    # stop one component
#   ./infra/down.sh --force          # also free the ports if something else holds them
#
# Flags:
#   --only <component>  one of: mock, bridge, web  (repeatable)
#   --force             kill whatever holds the ports, PID file or not
#   -q, --quiet         suppress progress output (still prints errors)
#   -h, --help          this text
#
# --force exists for the case up.sh refuses to start because a port is held by
# a process it does not own — a `pnpm dev:bridge` run by hand in another
# terminal, or an orphan from a crash. It kills by port, so use it knowing that.
#
# Exit: 0 always (stopping something already stopped is not an error).
# -----------------------------------------------------------------------------

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

FORCE=0
ONLY=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --only)     ONLY+=("${2:?--only needs a component}"); shift ;;
        --force)    FORCE=1 ;;
        -q|--quiet) QUIET=1 ;;
        -h|--help)  show_help "${BASH_SOURCE[0]}" ;;
        *) err "unknown option: $1"; err "try: $0 --help"; exit 2 ;;
    esac
    shift
done

if [[ ${#ONLY[@]} -eq 0 ]]; then ONLY=(web bridge mock); fi

port_of() {
    case "$1" in
        bridge) echo "${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}" ;;
        mock)   echo "${MOCK_PORT:-$MOCK_PORT_DEFAULT}" ;;
        web)    echo "${WEB_PORT:-$WEB_PORT_DEFAULT}" ;;
    esac
}

stopped_any=0
for name in "${ONLY[@]}"; do
    case "$name" in
        mock|bridge|web) ;;
        *) err "unknown component '$name' (expected: mock, bridge, web)"; exit 2 ;;
    esac

    if stop_component "$name"; then
        stopped_any=1
    elif [[ $FORCE -eq 1 ]]; then
        port="$(port_of "$name")"
        if port_open "$port"; then
            log "Forcing :$port free (no PID file — not started by up.sh)"
            if command -v lsof >/dev/null 2>&1; then
                lsof -ti ":$port" | xargs -r kill -9 2>/dev/null || true
                stopped_any=1
                ok "$name port :$port freed"
            else
                err "lsof not available — cannot force :$port"
            fi
        fi
    fi
done

# The mock binds a whole rebased set, not just its base port. --force should
# clear all of them, or a restart trips over a leftover listener.
if [[ $FORCE -eq 1 ]] && command -v lsof >/dev/null 2>&1; then
    for name in "${ONLY[@]}"; do
        [[ "$name" == mock ]] || continue
        base="${MOCK_PORT:-$MOCK_PORT_DEFAULT}"
        for offset in 0 10 20 30 40 50; do
            p=$(( base + offset ))
            if port_open "$p"; then
                lsof -ti ":$p" | xargs -r kill -9 2>/dev/null || true
                log "freed mock port :$p"
            fi
        done
    done
fi

if [[ $stopped_any -eq 0 ]]; then
    ok "nothing to stop"
fi
