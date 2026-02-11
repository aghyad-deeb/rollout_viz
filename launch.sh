#!/bin/bash

# Rollout Visualizer Launch Script
# Starts both the FastAPI backend and React frontend

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Rollout Visualizer...${NC}"

# Check if node_modules exists
if [ ! -d "frontend/node_modules" ]; then
    echo -e "${YELLOW}Installing frontend dependencies...${NC}"
    cd frontend && npm install && cd ..
fi

# Function to cleanup background processes on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start backend (run from project root so relative paths work)
echo -e "${GREEN}Starting backend on port 8000...${NC}"
source venv/bin/activate

# Backend reads all config (API keys, VIZ_PASSWORD) directly from ~/.env
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload &
BACKEND_PID=$!

# Wait for backend to be ready
sleep 2

# Start frontend
echo -e "${GREEN}Starting frontend on port 3000...${NC}"
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Rollout Visualizer is running!${NC}"
echo -e "${GREEN}Frontend: http://localhost:3000${NC}"
echo -e "${GREEN}Backend:  http://localhost:8000${NC}"
echo -e "${GREEN}API Docs: http://localhost:8000/docs${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop${NC}"

# Wait for both processes
wait
