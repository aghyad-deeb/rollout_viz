#!/usr/bin/env bash
# launch.sh — thin shim over supervisor.sh.
#
# The previous launch.sh ran the three services in a foreground bash that
# trapped SIGHUP and forwarded it to its children, so terminal disconnects
# (tmux detach gone wrong, SSH drop, logout) tore down the entire stack.
# It also relied on watchdog.sh, which only logged deaths and never
# restarted anything.
#
# Both problems are gone in supervisor.sh — see that script's docstring
# for the design. This file is kept so existing muscle memory and any
# `./launch.sh start|stop` automation still works.
#
#   ./launch.sh           → ./supervisor.sh start
#   ./launch.sh start     → ./supervisor.sh start
#   ./launch.sh stop      → ./supervisor.sh stop
#   ./launch.sh status    → ./supervisor.sh status
#   ./launch.sh logs ...  → ./supervisor.sh logs ...
#   ./launch.sh --legacy  → invoke the old foreground launcher
#                            (./launch.legacy.sh) — useful for debugging
#                            startup issues, NOT for running in production.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to `start` when invoked bare (`bash launch.sh`). Without this the
# `"${1:-start}"` only affects the case match — `"$@"` would still be empty,
# and supervisor.sh would print its usage banner instead of starting.
if [[ $# -eq 0 ]]; then
  set -- start
fi

case "$1" in
  --legacy|legacy)
    shift
    exec "$SCRIPT_DIR/launch.legacy.sh" "$@"
    ;;
  *)
    exec "$SCRIPT_DIR/supervisor.sh" "$@"
    ;;
esac
