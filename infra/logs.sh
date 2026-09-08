#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# salus-gui — read a component's log.
#
# up.sh runs each component detached with its output in infra/run/<name>.log.
# This is the shortcut for reading it.
#
# Usage:
#   ./infra/logs.sh bridge           # last 50 lines
#   ./infra/logs.sh bridge -f        # follow
#   ./infra/logs.sh mock -n 200      # last 200 lines
#
# Flags:
#   -f, --follow     tail -f
#   -n <lines>       how many lines (default 50)
#   -h, --help       this text
#
# Exit: 0 on success, 1 when the component has no log yet.
# -----------------------------------------------------------------------------

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

NAME=""
FOLLOW=0
LINES=50

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--follow) FOLLOW=1 ;;
        -n)          LINES="${2:?-n needs a value}"; shift ;;
        -h|--help)   show_help "${BASH_SOURCE[0]}" ;;
        -*) err "unknown option: $1"; exit 2 ;;
        *)  NAME="$1" ;;
    esac
    shift
done

if [[ -z "$NAME" ]]; then
    err "which component? (mock, bridge)"
    err "    ./infra/logs.sh bridge -f"
    exit 2
fi

lf="$(log_file "$NAME")"
if [[ ! -f "$lf" ]]; then
    err "no log at $lf"
    err "    has it been started?  ./infra/status.sh"
    exit 1
fi

if [[ $FOLLOW -eq 1 ]]; then
    exec tail -n "$LINES" -f "$lf"
else
    tail -n "$LINES" "$lf"
fi
