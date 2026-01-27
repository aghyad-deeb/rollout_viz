#!/bin/bash
# Start Rollout Visualizer development environment
#
# Usage:
#   ./start.sh              # Setup if needed, then start tmux session
#   ./start.sh --no-attach  # Start without attaching to tmux
#
# This script will:
#   1. Install nvm and Node.js 20 if not present
#   2. Create Python venv and install dependencies if needed
#   3. Install frontend npm dependencies if needed
#   4. Start backend and frontend in a tmux session

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SESSION_NAME="rollout_viz"
NO_ATTACH=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --no-attach)
            NO_ATTACH=true
            ;;
    esac
done

echo "============================================================"
echo "         Rollout Visualizer Development Environment"
echo "============================================================"
echo ""

# =============================================================================
# STEP 1: Setup nvm if needed
# =============================================================================

if [ ! -d "$HOME/.nvm" ]; then
    echo "Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    echo ""
fi

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if ! command -v nvm &> /dev/null; then
    echo "ERROR: nvm failed to load. Try opening a new terminal and running again."
    exit 1
fi

# =============================================================================
# STEP 2: Install Node.js 20 if needed
# =============================================================================

if ! nvm ls 20 &> /dev/null 2>&1; then
    echo "Installing Node.js 20..."
    nvm install 20
    echo ""
else
    echo "Node.js 20 already installed"
fi

nvm use 20 > /dev/null
echo "Using Node.js $(node -v) with npm $(npm -v)"
echo ""

# =============================================================================
# STEP 3: Setup Python venv if needed
# =============================================================================

if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    echo "Installing Python dependencies..."
    pip install -r requirements.txt
    echo ""
else
    echo "Python venv already exists"
    source venv/bin/activate
fi
echo "Using Python $(python --version)"
echo ""

# =============================================================================
# STEP 4: Install frontend npm dependencies if needed
# =============================================================================

if [ ! -d "frontend/node_modules" ]; then
    echo "Installing frontend npm dependencies..."
    cd frontend && npm install && cd ..
    echo ""
else
    echo "Frontend dependencies already installed"
fi
echo ""

# =============================================================================
# STEP 5: Start tmux session
# =============================================================================

# Check if session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Session '$SESSION_NAME' already running."
    if [ "$NO_ATTACH" = false ]; then
        echo "Attaching..."
        tmux attach-session -t "$SESSION_NAME"
    else
        echo "Use: tmux attach -t $SESSION_NAME"
    fi
    exit 0
fi

echo "Starting tmux session '$SESSION_NAME'..."

# Create new tmux session with shell window (index 0)
tmux new-session -d -s "$SESSION_NAME" -n "shell"
tmux send-keys -t "$SESSION_NAME:shell" "cd $SCRIPT_DIR && source venv/bin/activate && export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && nvm use 20" Enter

# Create backend window (index 1)
tmux new-window -t "$SESSION_NAME" -n "backend"
tmux send-keys -t "$SESSION_NAME:backend" "cd $SCRIPT_DIR && source venv/bin/activate && python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload" Enter

# Create frontend window (index 2)
tmux new-window -t "$SESSION_NAME" -n "frontend"
tmux send-keys -t "$SESSION_NAME:frontend" "cd $SCRIPT_DIR/frontend && export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && nvm use 20 && npm run dev" Enter

# Go back to shell window
tmux select-window -t "$SESSION_NAME:shell"

echo ""
echo "============================================================"
echo "                  SESSION STARTED"
echo "============================================================"
echo ""
echo "  Tmux session:  $SESSION_NAME"
echo "  Windows:       0:shell    (interactive shell)"
echo "                 1:backend  (uvicorn on port 8000)"
echo "                 2:frontend (vite on port 3000)"
echo ""
echo "  Frontend:      http://localhost:3000"
echo "  Backend:       http://localhost:8000"
echo "  API Docs:      http://localhost:8000/docs"
echo ""
echo "  To stop:       tmux kill-session -t $SESSION_NAME"
echo "  To attach:     tmux attach -t $SESSION_NAME"
echo ""
echo "============================================================"

if [ "$NO_ATTACH" = false ]; then
    echo "Attaching to session..."
    tmux attach-session -t "$SESSION_NAME"
fi
