#!/bin/bash

# Rollout Visualizer Launch Script
# Usage:
#   ./launch.sh          Start the app (backend + frontend + tunnel)
#   ./launch.sh stop     Stop all running instances

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PIDFILE="$SCRIPT_DIR/.rollout_viz.pids"
BACKEND_PORT=8000
FRONTEND_PORT=3000

# ──────────────────────────────────────────
# Stop command
# ──────────────────────────────────────────
stop_app() {
    echo -e "${YELLOW}Stopping Rollout Visualizer...${NC}"
    local killed=0

    # 1. Kill from saved PID file
    if [ -f "$PIDFILE" ]; then
        while read -r pid name; do
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "  Killing $name (PID $pid)"
                kill "$pid" 2>/dev/null || true
                killed=$((killed + 1))
            fi
        done < "$PIDFILE"
        rm -f "$PIDFILE"
    fi

    # 2. Kill anything on the backend port
    for pid in $(lsof -ti :$BACKEND_PORT 2>/dev/null || true); do
        local cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
        # Only kill our uvicorn/python processes, not unrelated services
        if [[ "$cmd" == *python* ]] || [[ "$cmd" == *uvicorn* ]]; then
            echo -e "  Killing process on port $BACKEND_PORT (PID $pid, $cmd)"
            kill "$pid" 2>/dev/null || true
            killed=$((killed + 1))
        fi
    done

    # 3. Kill anything on the frontend port
    for pid in $(lsof -ti :$FRONTEND_PORT 2>/dev/null || true); do
        local cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
        if [[ "$cmd" == *node* ]] || [[ "$cmd" == *vite* ]]; then
            echo -e "  Killing process on port $FRONTEND_PORT (PID $pid, $cmd)"
            kill "$pid" 2>/dev/null || true
            killed=$((killed + 1))
        fi
    done

    # 4. Kill any cloudflared tunnel for rollout-viz
    for pid in $(pgrep -f 'cloudflared tunnel run.*rollout-viz' 2>/dev/null || true); do
        echo -e "  Killing Cloudflare tunnel (PID $pid)"
        kill "$pid" 2>/dev/null || true
        killed=$((killed + 1))
    done

    if [ $killed -eq 0 ]; then
        echo -e "${YELLOW}No running instances found.${NC}"
    else
        echo -e "${GREEN}Stopped $killed process(es).${NC}"
    fi
}

if [ "${1:-}" = "stop" ]; then
    stop_app
    exit 0
fi

# ──────────────────────────────────────────
# Start command
# ──────────────────────────────────────────

# Stop any existing instances first
stop_app 2>/dev/null

echo -e "${GREEN}Starting Rollout Visualizer...${NC}"

# Check if node_modules exists
if [ ! -d "frontend/node_modules" ]; then
    echo -e "${YELLOW}Installing frontend dependencies...${NC}"
    cd frontend && npm install && cd ..
fi

# Crash log for forensics
CRASH_LOG="$SCRIPT_DIR/.crash.log"

# Function to cleanup background processes on exit
cleanup() {
    local signal="${1:-UNKNOWN}"
    local ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    echo -e "\n${YELLOW}Shutting down (signal: $signal)...${NC}"
    {
        echo "[$ts] launch.sh cleanup triggered by: $signal"
        echo "[$ts] launch.sh PID: $$, PPID: $PPID"
        echo "[$ts] Parent cmdline: $(tr '\0' ' ' < /proc/$PPID/cmdline 2>/dev/null || echo 'N/A')"
        echo "[$ts] Caller: $(caller 0 2>/dev/null || echo 'N/A')"
        echo "[$ts] TTY: $(tty 2>/dev/null || echo 'N/A')"
        echo "[$ts] Backend PID=$BACKEND_PID alive=$([ -d /proc/$BACKEND_PID ] && echo yes || echo no)"
        echo "[$ts] Frontend PID=$FRONTEND_PID alive=$([ -d /proc/$FRONTEND_PID ] && echo yes || echo no)"
        echo "[$ts] Tunnel PID=${TUNNEL_PID:-none} alive=$([ -n "$TUNNEL_PID" ] && [ -d /proc/$TUNNEL_PID ] && echo yes || echo no)"
        echo "[$ts] Load: $(cat /proc/loadavg)"
        echo "[$ts] Memory: $(free -h 2>/dev/null | grep Mem | awk '{print "used=" $3 " avail=" $7}')"
    } | tee -a "$CRASH_LOG"
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill $TUNNEL_PID 2>/dev/null || true
    rm -f "$PIDFILE"
    exit 0
}

_cleanup_done=false
trap 'if ! $_cleanup_done; then _cleanup_done=true; cleanup SIGINT; fi' SIGINT
trap 'if ! $_cleanup_done; then _cleanup_done=true; cleanup SIGTERM; fi' SIGTERM
trap 'if ! $_cleanup_done; then _cleanup_done=true; cleanup SIGHUP; fi' SIGHUP
trap 'if ! $_cleanup_done; then _cleanup_done=true; cleanup EXIT/child-died; fi' EXIT

# Start backend (run from project root so relative paths work)
echo -e "${GREEN}Starting backend on port $BACKEND_PORT...${NC}"
source venv/bin/activate

# Backend reads all config (API keys, VIZ_PASSWORD) directly from ~/.env
python -m uvicorn backend.main:app --host 127.0.0.1 --port $BACKEND_PORT --reload &
BACKEND_PID=$!

# Wait for backend to be ready (poll health endpoint)
echo -e "${YELLOW}Waiting for backend to be ready...${NC}"
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:$BACKEND_PORT/api/auth/check > /dev/null 2>&1; then
        echo -e "${GREEN}Backend is ready!${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Backend failed to start within 30 seconds${NC}"
        cleanup
    fi
    sleep 1
done

# Start frontend
echo -e "${GREEN}Starting frontend on port $FRONTEND_PORT...${NC}"
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

# Start Cloudflare tunnel if available and tunnel exists
TUNNEL_PID=""
if command -v cloudflared &> /dev/null && cloudflared tunnel list 2>/dev/null | grep -q "rollout-viz"; then
    echo -e "${GREEN}Starting Cloudflare tunnel...${NC}"
    cloudflared tunnel run --url http://localhost:$FRONTEND_PORT rollout-viz &
    TUNNEL_PID=$!
fi

# Save PIDs for stop command
echo "$BACKEND_PID backend" > "$PIDFILE"
echo "$FRONTEND_PID frontend" >> "$PIDFILE"
[ -n "$TUNNEL_PID" ] && echo "$TUNNEL_PID tunnel" >> "$PIDFILE"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Rollout Visualizer is running!${NC}"
echo -e "${GREEN}Frontend: http://localhost:$FRONTEND_PORT${NC}"
echo -e "${GREEN}Backend:  http://localhost:$BACKEND_PORT${NC}"
echo -e "${GREEN}API Docs: http://localhost:$BACKEND_PORT/docs${NC}"
if [ -n "$TUNNEL_PID" ]; then
echo -e "${GREEN}Tunnel:   https://rollout-viz.com${NC}"
fi
echo -e "${GREEN}========================================${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop, or run: ./launch.sh stop${NC}"

# Wait for all processes
wait
