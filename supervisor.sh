#!/usr/bin/env bash
# supervisor.sh — robust process supervisor for rollout_viz.
#
# Replaces the launch.sh + watchdog.sh combo with a single self-daemonizing
# process that owns the backend and Cloudflare tunnel and brings them
# back up automatically when they die. The backend serves the production
# frontend build; Vite dev mode is never exposed publicly.
#
# Design goals (vs. the previous launch.sh + watchdog.sh):
#   1. Survive terminal/SSH/tmux disconnects.
#      `setsid + nohup` plus `trap '' SIGHUP` means losing the parent shell
#      doesn't cascade into killing children. The previous launch.sh
#      explicitly trapped SIGHUP and called cleanup → killed everything.
#   2. Auto-restart with exponential backoff.
#      The previous watchdog only logged deaths and then exited.
#   3. Treat ports — not PIDs — as the source of truth.
#      `npm run dev &` returns the wrapper PID, not the vite PID. Port
#      probes catch both "wrapper exited but vite is fine" and "vite is
#      hung but PID still exists" cases.
#   4. Single coherent inventory of running services in
#      .supervisor.<name>.pid; no mixed cohorts of stale PID files.
#   5. Bounded log growth via size-based rotation (10 MB → .old).
#
# Usage:
#   ./supervisor.sh start         daemonize and start all services
#   ./supervisor.sh stop          stop the supervisor and all services
#   ./supervisor.sh restart       stop + start
#   ./supervisor.sh status        show service state, ports, recent logs
#   ./supervisor.sh logs [name]   tail -F the named log (default: supervisor)
#
# Logs live in ./logs/<service>.log. The supervisor's own log is
# ./logs/supervisor.log.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Configuration ──────────────────────────────────────────────────────
BACKEND_PORT=3000
# Prefer a repo-local venv, but support this transfer layout where the shared
# reward_seeker venv lives one directory above the app checkout.
VENV_DIR="${VENV_DIR:-$SCRIPT_DIR/venv}"
if [[ ! -x "$VENV_DIR/bin/python" && -x "$SCRIPT_DIR/../venv/bin/python" ]]; then
  VENV_DIR="$SCRIPT_DIR/../venv"
fi
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
TUNNEL_NAME="${TUNNEL_NAME:-rollout-viz}"
TUNNEL_TOKEN_FILE="${TUNNEL_TOKEN_FILE:-$HOME/.cloudflared/$TUNNEL_NAME.token}"
# `cloudflared service install <token>` creates a systemd connector that owns
# the tunnel independently of this app supervisor. In that common deployment,
# launch.sh should only keep the backend alive and let systemd keep the public
# connector alive. Set USE_SYSTEM_CLOUDFLARED=false to force the supervisor to
# run its own tunnel process instead.
SYSTEM_CLOUDFLARED_SERVICE="${SYSTEM_CLOUDFLARED_SERVICE:-cloudflared}"
USE_SYSTEM_CLOUDFLARED="${USE_SYSTEM_CLOUDFLARED:-auto}"
# Port 3000 was previously used by Vite dev. Keep it only for cleanup; when
# BACKEND_PORT is also 3000, the duplicate cleanup pass is harmless.
DEV_FRONTEND_PORT=3000
LOG_DIR="$SCRIPT_DIR/logs"
LOG_MAX_BYTES=$((10 * 1024 * 1024))          # 10 MB before rotation
HEALTH_INTERVAL=30                            # seconds between probes
HEALTH_GRACE=10                               # second-chance after a probe fail
RESTART_BACKOFF_LIMIT_SECONDS=60              # max backoff between restarts

SUPERVISOR_PID_FILE="$SCRIPT_DIR/.supervisor.pid"
SHUTDOWN_FLAG="$SCRIPT_DIR/.supervisor.stop"

system_cloudflared_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl is-active --quiet "$SYSTEM_CLOUDFLARED_SERVICE" 2>/dev/null
}

use_system_cloudflared() {
  case "${USE_SYSTEM_CLOUDFLARED,,}" in
    1|true|yes|on) return 0 ;;
    0|false|no|off) return 1 ;;
    auto|"") system_cloudflared_active ;;
    *) system_cloudflared_active ;;
  esac
}

if use_system_cloudflared; then
  SERVICES=(backend)
else
  SERVICES=(backend tunnel)
fi

# Per-service: command to run (one shell command, may include `cd` etc.)
service_cmd() {
  case "$1" in
    backend)
      printf 'exec %q -m uvicorn backend.main:app --host 127.0.0.1 --port %q
' \
        "$VENV_DIR/bin/python" "$BACKEND_PORT"
      ;;
    tunnel)
      if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
        printf 'exec %q tunnel run --url %q
' \
          "$CLOUDFLARED_BIN" "http://localhost:$BACKEND_PORT"
      elif [[ -r "$TUNNEL_TOKEN_FILE" ]]; then
        printf 'exec %q tunnel run --url %q --token-file %q
' \
          "$CLOUDFLARED_BIN" "http://localhost:$BACKEND_PORT" "$TUNNEL_TOKEN_FILE"
      else
        printf 'exec %q tunnel run --url %q %q
' \
          "$CLOUDFLARED_BIN" "http://localhost:$BACKEND_PORT" "$TUNNEL_NAME"
      fi
      ;;
    *) return 1 ;;
  esac
}

# Per-service: TCP port to health-check (empty = no probe, just PID check).
service_port() {
  case "$1" in
    backend)  echo "$BACKEND_PORT" ;;
    tunnel)   echo "" ;;
  esac
}

# Per-service: HTTP path to probe on the port. Backend's `/` returns 404
# from FastAPI, so use `/api/health` instead. Vite's `/` returns 200.
service_probe_path() {
  case "$1" in
    backend)  echo "/api/health" ;;
    *)        echo "/" ;;
  esac
}

# ── Helpers ────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"

ts()   { printf '%(%Y-%m-%dT%H:%M:%SZ)T' -1; }
slog() { echo "$(ts) $*" >> "$LOG_DIR/supervisor.log"; }

rotate_log() {
  local f=$1
  [[ -f $f ]] || return 0
  local size; size=$(stat -c %s "$f" 2>/dev/null || echo 0)
  if (( size > LOG_MAX_BYTES )); then
    mv -f "$f" "$f.old" 2>/dev/null || true
    : > "$f"
  fi
}

is_alive() { [[ -d /proc/$1 ]]; }

# Find a port's listening PID. Returns first match or empty.
port_pid() {
  ss -tlnp "( sport = :$1 )" 2>/dev/null | awk -F'pid=' '/pid=/ {split($2,a,","); print a[1]; exit}'
}

# Find all listening PIDs for a port. uvicorn --reload can leave parent and
# child processes sharing the socket, so stop needs more than the first PID.
port_pids() {
  ss -tlnp "( sport = :$1 )" 2>/dev/null \
    | awk 'match($0, /pid=[0-9]+/) {pid=substr($0, RSTART + 4, RLENGTH - 4); if (!seen[pid]++) print pid}'
}

read_env_key() {
  local key=$1
  local env_file="$HOME/.env"
  [[ -f $env_file ]] || return 0
  awk -F= -v key="$key" '$1 == key {print substr($0, length(key) + 2); exit}' "$env_file" \
    | sed 's/^ *//; s/ *$//; s/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//'
}

check_security_config() {
  local password secret buckets
  password=$(read_env_key VIZ_PASSWORD || true)
  secret=$(read_env_key VIZ_SECRET_KEY || true)
  buckets=$(read_env_key VIZ_ALLOWED_S3_BUCKETS || true)

  if [[ -n $password && -z $secret ]]; then
    echo "Refusing to start: VIZ_PASSWORD is set but VIZ_SECRET_KEY is missing from ~/.env."
    echo "Generate one with: openssl rand -hex 32"
    return 1
  fi

  if [[ -n $(read_env_key AWS_ACCESS_KEY_ID || true) || -n $(read_env_key AWS_SECRET_ACCESS_KEY || true) ]]; then
    if [[ -z $buckets ]]; then
      echo "Refusing to start: AWS credentials are configured but VIZ_ALLOWED_S3_BUCKETS is missing from ~/.env."
      echo "Set it to a comma-separated allowlist, for example: VIZ_ALLOWED_S3_BUCKETS=rewardseeker"
      return 1
    fi
  fi
}

check_backend_runtime() {
  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    echo "Missing Python venv at $VENV_DIR."
    echo "Set VENV_DIR to the venv path, or create ./venv."
    return 1
  fi
  if ! "$VENV_DIR/bin/python" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
    echo "Backend runtime dependencies are missing from $VENV_DIR."
    echo "Install with: uv pip install -r requirements.txt --python $VENV_DIR/bin/python"
    return 1
  fi
}

check_public_tunnel_runtime() {
  if use_system_cloudflared; then
    if system_cloudflared_active; then
      return 0
    fi
    echo "USE_SYSTEM_CLOUDFLARED is enabled, but systemd service '$SYSTEM_CLOUDFLARED_SERVICE' is not active."
    echo "Start it with: sudo systemctl start $SYSTEM_CLOUDFLARED_SERVICE"
    return 1
  fi

  if ! command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1; then
    echo "Missing cloudflared; cannot start the public rollout-viz.com tunnel."
    echo "Install cloudflared or set CLOUDFLARED_BIN to its absolute path."
    return 1
  fi
  if [[ -n "${TUNNEL_TOKEN:-}" || -r "$TUNNEL_TOKEN_FILE" ]]; then
    return 0
  fi
  if ! "$CLOUDFLARED_BIN" tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
    echo "Missing Cloudflare credentials for tunnel '$TUNNEL_NAME'."
    echo "Set TUNNEL_TOKEN for this process, place a readable token in $TUNNEL_TOKEN_FILE,"
    echo "restore ~/.cloudflared credentials for the named tunnel,"
    echo "or start the systemd connector: sudo systemctl start $SYSTEM_CLOUDFLARED_SERVICE"
    return 1
  fi
}

build_frontend() {
  if [[ ! -f frontend/package.json ]]; then
    echo "Missing frontend/package.json"
    return 1
  fi
  if [[ ! -d frontend/node_modules ]]; then
    if [[ -f frontend/dist/index.html ]]; then
      echo "Missing frontend/node_modules; using existing frontend/dist build."
      return 0
    fi
    echo "Missing frontend/node_modules and frontend/dist/index.html."
    echo "Run npm install in ./frontend first, then npm run build."
    return 1
  fi
  echo "Building production frontend..."
  (cd frontend && npm run build)
}

# ── Per-service supervision loop ───────────────────────────────────────
# Each service runs in its own bash subshell that loops forever (until the
# shutdown flag appears). On crash, we record the timestamp; if 5 crashes
# happen within a minute we force a longer cool-down so a permanently
# broken service doesn't burn CPU.
supervise_one() {
  local name=$1
  local cmd; cmd=$(service_cmd "$name") || { slog "[$name] no command defined"; return 1; }
  local logf="$LOG_DIR/$name.log"
  local pidf="$SCRIPT_DIR/.supervisor.${name}.pid"

  # Recent failure timestamps (epoch seconds).
  local recent=()

  while [[ ! -f $SHUTDOWN_FLAG ]]; do
    rotate_log "$logf"
    slog "[$name] starting"
    # Belt-and-suspenders signal isolation. The supervisor itself already
    # ignores SIGHUP and lives in a session without a controlling terminal,
    # but we also:
    #   • `nohup`           → child explicitly ignores SIGHUP
    #   • `setsid`          → child starts a new session AND process group,
    #                         so a process-group signal hitting the
    #                         supervisor (kill -- -SUPERVISOR_PID) doesn't
    #                         cascade to services
    #   • `< /dev/null`     → no inherited stdin; can't be killed by EOF
    # Because `setsid` makes the wrapper a process-group leader, we kill
    # the whole subtree later via `kill -- -$svc_pid`. That matters because
    # `npm run dev` spawns vite as a grandchild — without process-group
    # kill, the wrapper dies but vite leaks.
    nohup setsid bash -c "$cmd" >> "$logf" 2>&1 < /dev/null &
    local svc_pid=$!
    echo "$svc_pid" > "$pidf"

    # Wait until either the service exits or shutdown is requested.
    while is_alive "$svc_pid"; do
      if [[ -f $SHUTDOWN_FLAG ]]; then
        slog "[$name] shutdown flag set — SIGTERM to process group $svc_pid"
        kill -TERM -- -"$svc_pid" 2>/dev/null || kill -TERM "$svc_pid" 2>/dev/null || true
        for _ in $(seq 1 10); do is_alive "$svc_pid" || break; sleep 1; done
        if is_alive "$svc_pid"; then
          slog "[$name] still alive after 10s — SIGKILL"
          kill -KILL -- -"$svc_pid" 2>/dev/null || kill -KILL "$svc_pid" 2>/dev/null || true
        fi
        break
      fi
      sleep 2
    done

    wait "$svc_pid" 2>/dev/null
    local rc=$?
    # Clean up any grandchildren that survived (npm → vite is the typical
    # case). Kill the whole process group; if it's already gone, this is a
    # no-op.
    kill -TERM -- -"$svc_pid" 2>/dev/null || true
    rm -f "$pidf"
    slog "[$name] exited rc=$rc"
    [[ -f $SHUTDOWN_FLAG ]] && break

    # Update recent-failures window.
    local now; now=$(date +%s)
    recent+=("$now")
    # Keep only timestamps within the last 60 seconds.
    local pruned=()
    local t
    for t in "${recent[@]}"; do
      (( now - t < 60 )) && pruned+=("$t")
    done
    recent=("${pruned[@]}")

    if (( ${#recent[@]} >= 5 )); then
      slog "[$name] 5 crashes in 60s — sleeping ${RESTART_BACKOFF_LIMIT_SECONDS}s before retry"
      sleep "$RESTART_BACKOFF_LIMIT_SECONDS"
      recent=()
    else
      # Quadratic-ish backoff: 2, 4, 8, 16, 32 capped at limit.
      local n=${#recent[@]}
      local delay=$(( n * n + 1 ))
      (( delay > RESTART_BACKOFF_LIMIT_SECONDS )) && delay=$RESTART_BACKOFF_LIMIT_SECONDS
      sleep "$delay"
    fi
  done
  slog "[$name] supervisor loop exited"
}

# ── Health checker ─────────────────────────────────────────────────────
# A service can be "alive" by PID but unresponsive on its port (deadlocked
# event loop, OOM thrashing, etc.). We probe each ported service every
# HEALTH_INTERVAL seconds; if it fails twice in a row (separated by
# HEALTH_GRACE) we kill it so its supervisor loop restarts it.
health_check() {
  while [[ ! -f $SHUTDOWN_FLAG ]]; do
    local name
    for name in "${SERVICES[@]}"; do
      local port; port=$(service_port "$name")
      [[ -z $port ]] && continue
      local path; path=$(service_probe_path "$name")
      local pidf="$SCRIPT_DIR/.supervisor.${name}.pid"
      [[ -f $pidf ]] || continue
      local pid; pid=$(cat "$pidf" 2>/dev/null || true)
      [[ -n $pid ]] && is_alive "$pid" || continue

      if ! curl -sf -m 5 "http://127.0.0.1:${port}${path}" >/dev/null 2>&1; then
        sleep "$HEALTH_GRACE"
        if ! curl -sf -m 5 "http://127.0.0.1:${port}${path}" >/dev/null 2>&1; then
          slog "[health] $name (port $port) unresponsive — killing supervised pid $pid for restart"
          # Kill the wrapper; we may also have to kill the actual port owner
          # in case it's a grandchild that survives the wrapper.
          kill -TERM "$pid" 2>/dev/null || true
          local listener; listener=$(port_pid "$port" || true)
          [[ -n $listener && $listener != "$pid" ]] && kill -TERM "$listener" 2>/dev/null || true
        fi
      fi
    done
    sleep "$HEALTH_INTERVAL"
  done
}

# ── Daemon entrypoint ──────────────────────────────────────────────────
run_daemon() {
  echo "$$" > "$SUPERVISOR_PID_FILE"
  trap '' SIGHUP                         # outlive terminal disconnects
  trap 'request_shutdown' SIGTERM SIGINT
  rotate_log "$LOG_DIR/supervisor.log"
  slog "supervisor started pid=$$ pwd=$SCRIPT_DIR"

  for name in "${SERVICES[@]}"; do
    supervise_one "$name" &
  done
  health_check &

  wait
  rm -f "$SUPERVISOR_PID_FILE" "$SHUTDOWN_FLAG"
  slog "supervisor exited"
}

request_shutdown() {
  slog "supervisor caught signal — beginning shutdown"
  touch "$SHUTDOWN_FLAG"
}

# ── Public commands ────────────────────────────────────────────────────
cmd_start() {
  if [[ -f $SUPERVISOR_PID_FILE ]] && is_alive "$(cat "$SUPERVISOR_PID_FILE" 2>/dev/null || echo 0)"; then
    echo "Already running (PID $(cat "$SUPERVISOR_PID_FILE"))."
    return 0
  fi
  rm -f "$SHUTDOWN_FLAG" "$SUPERVISOR_PID_FILE"

  check_security_config || return 1
  check_backend_runtime || return 1
  check_public_tunnel_runtime || return 1
  if use_system_cloudflared; then
    echo "Using active systemd Cloudflare connector '$SYSTEM_CLOUDFLARED_SERVICE'; supervisor will manage backend only."
  fi
  build_frontend || return 1

  # Refuse to start if ports are already taken by something we don't own;
  # otherwise the supervised loops will infinitely thrash.
  local p
  for p in "$BACKEND_PORT"; do
    if [[ -n "$(port_pid "$p" || true)" ]]; then
      echo "Port $p is already in use:"
      ss -tlnp "( sport = :$p )" | sed 's/^/  /'
      echo
      echo "Stop the conflicting process and re-run, or run './supervisor.sh stop'."
      return 1
    fi
  done

  # Daemonize. setsid detaches from the controlling terminal; nohup ignores
  # SIGHUP during the brief window before the daemon's own trap installs.
  if [[ -z "${SUPERVISOR_DAEMONIZED:-}" ]]; then
    SUPERVISOR_DAEMONIZED=1 nohup setsid bash "$0" __daemon \
      >> "$LOG_DIR/supervisor.log" 2>&1 < /dev/null &
    disown 2>/dev/null || true
    # Brief wait for the pid file to materialize so we can report it.
    local i
    for i in $(seq 1 20); do
      [[ -f $SUPERVISOR_PID_FILE ]] && break
      sleep 0.1
    done
    if [[ -f $SUPERVISOR_PID_FILE ]]; then
      echo "Started (supervisor PID $(cat "$SUPERVISOR_PID_FILE"))."
      sleep 1
      cmd_status || true
    else
      echo "Failed to start — see $LOG_DIR/supervisor.log"
      return 1
    fi
    return 0
  fi
  run_daemon
}

cmd_stop() {
  if [[ -f $SUPERVISOR_PID_FILE ]]; then
    local sup; sup=$(cat "$SUPERVISOR_PID_FILE" 2>/dev/null || true)
    if [[ -n $sup ]] && is_alive "$sup"; then
      echo "Stopping supervisor (PID $sup)..."
      touch "$SHUTDOWN_FLAG"
      kill -TERM "$sup" 2>/dev/null || true
      local i
      for i in $(seq 1 20); do is_alive "$sup" || break; sleep 1; done
      if is_alive "$sup"; then
        echo "Supervisor didn't stop within 20s — sending SIGKILL"
        kill -KILL "$sup" 2>/dev/null || true
      fi
    fi
  else
    echo "No supervisor pid file."
  fi

  # Older supervisor versions could leave orphan daemon loops if pid files
  # drifted. Stop any daemon for this exact app directory before cleaning
  # service ports, but do not match this foreground `stop` command.
  local stale_sup stale_cwd stale_cmd
  for stale_sup in $(pgrep -f "bash .*supervisor.sh __daemon" 2>/dev/null || true); do
    stale_cwd=$(readlink "/proc/$stale_sup/cwd" 2>/dev/null || true)
    stale_cmd=$(ps -p "$stale_sup" -o args= 2>/dev/null || true)
    if [[ $stale_sup != $$ && $stale_cwd == "$SCRIPT_DIR" && $stale_cmd == *" __daemon"* ]]; then
      kill -TERM "$stale_sup" 2>/dev/null || true
    fi
  done

  # Belt-and-suspenders: kill any stragglers on our ports / tunnel name,
  # mirroring launch.sh's stop logic. Restricted to processes we recognize.
  local pid cmd
  local pgid
  for pid in $(port_pids "$BACKEND_PORT" || true); do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    if [[ "$cmd" == *python* || "$cmd" == *uvicorn* ]]; then
      pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
      [[ -n $pgid ]] && kill -TERM -- -"$pgid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for pid in $(port_pids "$DEV_FRONTEND_PORT" || true); do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    if [[ "$cmd" == *node* || "$cmd" == *vite* ]]; then
      pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
      [[ -n $pgid ]] && kill -TERM -- -"$pgid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
  pkill -f 'cloudflared tunnel run.*rollout-viz' 2>/dev/null || true
  pkill -f "$SCRIPT_DIR/frontend/node_modules/.bin/vite" 2>/dev/null || true

  rm -f "$SUPERVISOR_PID_FILE" "$SHUTDOWN_FLAG"
  rm -f "$SCRIPT_DIR"/.supervisor.*.pid 2>/dev/null || true
  echo "Stopped."
}

cmd_status() {
  if [[ ! -f $SUPERVISOR_PID_FILE ]]; then
    echo "Supervisor: NOT RUNNING"
    return 1
  fi
  local sup; sup=$(cat "$SUPERVISOR_PID_FILE" 2>/dev/null || true)
  if [[ -z $sup ]] || ! is_alive "$sup"; then
    echo "Supervisor: STALE pid file ($sup)"
    return 1
  fi
  local etime; etime=$(ps -o etime= -p "$sup" 2>/dev/null | tr -d ' ')
  echo "Supervisor: PID $sup, uptime $etime"

  printf '\n  %-10s %-6s %-12s %-10s %s\n' SERVICE PORT STATE PID PROBE
  for name in "${SERVICES[@]}"; do
    local port; port=$(service_port "$name")
    local pidf="$SCRIPT_DIR/.supervisor.${name}.pid"
    local pid="—" state="DOWN" probe="—"
    if [[ -f $pidf ]]; then
      pid=$(cat "$pidf" 2>/dev/null || echo "?")
      if is_alive "$pid"; then state="up"; else state="DEAD"; fi
    fi
    if [[ -n $port ]]; then
      local path; path=$(service_probe_path "$name")
      local code
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${port}${path}" 2>/dev/null || echo 000)
      probe="HTTP $code"
    fi
    printf '  %-10s %-6s %-12s %-10s %s\n' "$name" "${port:-—}" "$state" "$pid" "$probe"
  done
  if use_system_cloudflared; then
    local cf_state=DOWN
    if system_cloudflared_active; then cf_state=active; fi
    printf '\n  %-10s %-6s %-12s %-10s %s\n' tunnel — "systemd:$cf_state" "$SYSTEM_CLOUDFLARED_SERVICE" external
  fi
  echo
  echo "Logs: $LOG_DIR/<service>.log     ('./supervisor.sh logs <name>' to tail)"
}

cmd_logs() {
  local what="${1:-supervisor}"
  local f="$LOG_DIR/$what.log"
  if [[ ! -f $f ]]; then
    echo "No log at $f"
    echo "Available:"
    ls "$LOG_DIR" 2>/dev/null | sed 's/^/  /'
    return 1
  fi
  exec tail -F "$f"
}

# ── Dispatch ───────────────────────────────────────────────────────────
case "${1:-}" in
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_stop; sleep 1; cmd_start ;;
  status)   cmd_status ;;
  logs)     cmd_logs "${2:-supervisor}" ;;
  __daemon) run_daemon ;;     # internal — invoked by `start` after setsid
  *)
    cat <<EOF
Usage: $0 {start|stop|restart|status|logs [service]}
  Services: ${SERVICES[*]}
  Logs:     $LOG_DIR/<service>.log
EOF
    exit 2
    ;;
esac
