#!/bin/bash
# Watchdog: monitors rollout-viz processes and logs WHY they die.
# Run alongside launch.sh: ./watchdog.sh &
# Logs to .watchdog.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/.watchdog.log"
PIDFILE="$SCRIPT_DIR/.rollout_viz.pids"
CHECK_INTERVAL=5  # seconds

log() {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"
}

log "========== Watchdog started (PID $$) =========="
log "Machine uptime: $(uptime)"
log "Current user: $(whoami)"
log "tmux sessions: $(tmux list-sessions 2>/dev/null | tr '\n' '; ')"

# Wait for PID file to appear
for i in $(seq 1 30); do
    [ -f "$PIDFILE" ] && break
    sleep 1
done

if [ ! -f "$PIDFILE" ]; then
    log "ERROR: PID file never appeared after 30s. Exiting."
    exit 1
fi

# Read PIDs
declare -A PIDS
while read -r pid name; do
    PIDS[$name]=$pid
done < "$PIDFILE"

log "Monitoring processes:"
for name in "${!PIDS[@]}"; do
    pid=${PIDS[$name]}
    if [ -d "/proc/$pid" ]; then
        ppid=$(cat /proc/$pid/stat 2>/dev/null | awk '{print $4}')
        cmdline=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
        log "  $name: PID=$pid, PPID=$ppid, cmd=$cmdline"
    else
        log "  $name: PID=$pid (already dead!)"
    fi
done

# Also find the launch.sh parent
launch_pid=""
for name in "${!PIDS[@]}"; do
    pid=${PIDS[$name]}
    if [ -d "/proc/$pid" ]; then
        ppid=$(cat /proc/$pid/stat 2>/dev/null | awk '{print $4}')
        if [ -n "$ppid" ] && [ -d "/proc/$ppid" ]; then
            pcmd=$(tr '\0' ' ' < /proc/$ppid/cmdline 2>/dev/null)
            if [[ "$pcmd" == *launch.sh* ]] || [[ "$pcmd" == *bash* ]]; then
                launch_pid=$ppid
            fi
        fi
    fi
done
if [ -n "$launch_pid" ]; then
    log "Parent launch.sh: PID=$launch_pid"
    # Log the full process tree
    log "Process tree:"
    pstree -p "$launch_pid" 2>/dev/null | head -20 | while read -r line; do log "  $line"; done
fi

# Monitor loop
prev_status=""
while true; do
    sleep "$CHECK_INTERVAL"

    all_alive=true
    status=""
    for name in "${!PIDS[@]}"; do
        pid=${PIDS[$name]}
        if [ -d "/proc/$pid" ]; then
            # Process alive — check its state
            state=$(cat /proc/$pid/stat 2>/dev/null | awk '{print $3}')
            status+="$name($pid):$state "
        else
            all_alive=false
            # Process DIED — gather forensics
            log "!!!!! $name (PID $pid) IS DEAD !!!!!"

            # Check if it was OOM-killed
            dmesg -T 2>/dev/null | grep -i "killed process $pid" | tail -3 | while read -r line; do
                log "  dmesg: $line"
            done

            # Check wait status if we can
            wait "$pid" 2>/dev/null
            exit_code=$?
            log "  Exit code: $exit_code"

            # Signal mapping: 128+N means killed by signal N
            if [ $exit_code -gt 128 ]; then
                sig=$((exit_code - 128))
                case $sig in
                    1)  signame="SIGHUP (terminal closed/disconnected)" ;;
                    2)  signame="SIGINT (Ctrl+C)" ;;
                    9)  signame="SIGKILL (force kill, possibly OOM)" ;;
                    13) signame="SIGPIPE (broken pipe)" ;;
                    15) signame="SIGTERM (graceful termination)" ;;
                    *)  signame="Signal $sig" ;;
                esac
                log "  Killed by: $signame"
            fi

            # Check parent status
            if [ -n "$launch_pid" ]; then
                if [ -d "/proc/$launch_pid" ]; then
                    log "  Parent launch.sh ($launch_pid) is still alive"
                else
                    log "  Parent launch.sh ($launch_pid) is ALSO dead"
                fi
            fi

            # Check who else is on the ports
            for port in 3000 8010; do
                occupant=$(ss -tlnp 2>/dev/null | grep ":$port " | head -1)
                if [ -n "$occupant" ]; then
                    log "  Port $port: $occupant"
                else
                    log "  Port $port: nobody listening"
                fi
            done

            # Snapshot system state
            log "  Load average: $(cat /proc/loadavg)"
            log "  Memory: $(free -h | grep Mem | awk '{print "used=" $3 " free=" $4 " available=" $7}')"

            # Check tmux session state
            tmux_state=$(tmux list-sessions 2>/dev/null | grep viz)
            log "  tmux viz session: ${tmux_state:-NOT FOUND}"

            # Check if any other process sent the kill
            log "  Last 5 audit kills:"
            ausearch -m KILL --start recent 2>/dev/null | tail -5 | while read -r line; do log "    $line"; done
        fi
    done

    # Log periodic heartbeat (every 60s = every 12 checks)
    if [ $((SECONDS % 60)) -lt "$CHECK_INTERVAL" ] && [ -n "$status" ]; then
        log "Heartbeat: $status"
    fi

    if ! $all_alive; then
        # Check if ALL are dead
        any_alive=false
        for name in "${!PIDS[@]}"; do
            [ -d "/proc/${PIDS[$name]}" ] && any_alive=true
        done
        if ! $any_alive; then
            log "All processes dead. Watchdog exiting."
            log "Final system state:"
            log "  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
            log "  Load: $(cat /proc/loadavg)"
            log "  Memory: $(free -h | grep Mem)"
            log "  Ports 3000/8010: $(ss -tlnp 2>/dev/null | grep -E ':3000|:8010')"
            exit 0
        fi
    fi
done
