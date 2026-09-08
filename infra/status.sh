#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# salus-gui — what is up, and what the bridge is pointed at.
#
# Reports the console's own processes AND the platform stacks behind them,
# because "the panel is empty" is nearly always one of the two: the bridge is
# down, or the fleet it dials is. Reporting both in one place is the point.
#
# Usage:
#   ./infra/status.sh
#
# Flags:
#   -q, --quiet   print only the one-line verdict
#   -h, --help    this text
#
# Exit: 0 when the console stack is up, 1 when any part of it is down.
# -----------------------------------------------------------------------------

set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -q|--quiet) QUIET=1 ;;
        -h|--help)  show_help "${BASH_SOURCE[0]}" ;;
        *) err "unknown option: $1"; exit 2 ;;
    esac
    shift
done

BRIDGE_PORT="${BRIDGE_PORT:-$BRIDGE_PORT_DEFAULT}"
MOCK_PORT="${MOCK_PORT:-$MOCK_PORT_DEFAULT}"

row() { # row <label> <up?> <detail>
    local label="$1" up="$2" detail="$3"
    if [[ $QUIET -eq 1 ]]; then return; fi
    if [[ "$up" == "1" ]]; then
        printf "  ${LGREEN}✓${RESET} %-14s %s\n" "$label" "${DIM}${detail}${RESET}"
    else
        printf "  ${LRED}✗${RESET} %-14s %s\n" "$label" "${DIM}${detail}${RESET}"
    fi
}

skip_row() {
    [[ $QUIET -eq 1 ]] && return
    printf "  ${LYELLOW}⊘${RESET} %-14s %s\n" "$1" "${DIM}${2}${RESET}"
}

console_ok=1

[[ $QUIET -eq 0 ]] && echo && echo "${BOLD}Console${RESET}"

# --- mock -------------------------------------------------------------------
if port_open "$MOCK_PORT"; then
    pid="$(running_pid mock)"
    row "mock" 1 ":$MOCK_PORT${pid:+ (pid $pid)}"
else
    row "mock" 0 ":$MOCK_PORT — not listening"
fi

# --- web --------------------------------------------------------------------
WEB_PORT="${WEB_PORT:-$WEB_PORT_DEFAULT}"
if port_open "$WEB_PORT"; then
    pid="$(running_pid web)"
    row "console" 1 "http://localhost:$WEB_PORT${pid:+ (pid $pid)}"
else
    row "console" 0 ":$WEB_PORT — not listening"
fi

# --- bridge -----------------------------------------------------------------
if port_open "$BRIDGE_PORT"; then
    pid="$(running_pid bridge)"
    info="$(curl -sk --http2 --max-time 3 "https://localhost:$BRIDGE_PORT/bridge/info" 2>/dev/null)"
    if [[ -n "$info" ]]; then
        site="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(`site ${j.site} (${j.env})${j.readOnly?" READ-ONLY":""}`)}catch{process.stdout.write("responding")}})' <<<"$info" 2>/dev/null)"
        row "bridge" 1 ":$BRIDGE_PORT — ${site}${pid:+, pid $pid}"
    else
        # Listening but not answering is worth distinguishing from down: it is
        # usually a cert the client refuses, not a dead process.
        row "bridge" 0 ":$BRIDGE_PORT — listening but /bridge/info did not answer"
        console_ok=0
    fi
else
    row "bridge" 0 ":$BRIDGE_PORT — not listening"
    console_ok=0
fi

# --- platform ---------------------------------------------------------------
[[ $QUIET -eq 0 ]] && echo && echo "${BOLD}Salus platform${RESET} ${DIM}(what the bridge dials in --live mode)${RESET}"

if [[ -d "$SALUS_ROOT" ]]; then
    for probe in "Network:57000" "Authentication:57010" "Session:57020" \
                 "Health:57030" "Therapy:57040" "Protocol:57050"; do
        name="${probe%%:*}"; port="${probe##*:}"
        if port_open "$port"; then row "$name" 1 ":$port"; else skip_row "$name" ":$port — down"; fi
    done
    for probe in "Envoy edge:58000" "Envoy admin:58009" "Postgres:55432" "ClickHouse:59000"; do
        name="${probe%%:*}"; port="${probe##*:}"
        if port_open "$port"; then row "$name" 1 ":$port"; else skip_row "$name" ":$port — down"; fi
    done
else
    skip_row "checkout" "no Salus repo at $SALUS_ROOT (set SALUS_ROOT to point elsewhere)"
fi

if [[ $QUIET -eq 0 ]]; then
    echo
    if [[ $console_ok -eq 1 ]]; then
        ok "console stack up"
    else
        err "console stack is not fully up — ${BOLD}./infra/up.sh${RESET}"
    fi
    echo
fi

[[ $console_ok -eq 1 ]] || exit 1
