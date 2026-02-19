# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Rollout Visualizer — a full-stack app for browsing, searching, and LLM-grading conversation traces (rollout logs) stored as JSONL files (local or S3).

## Commands

```bash
# Start everything (backend + frontend)
./launch.sh

# Backend only (run from project root, not backend/)
source venv/bin/activate
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload

# Frontend only
cd frontend && npm run dev

# Build frontend for production
cd frontend && npm run build

# Lint frontend
cd frontend && npm run lint

# Expose via tunnel (pick one)
cloudflared tunnel --url http://localhost:3000
ngrok http 3000 --domain YOUR-DOMAIN.ngrok-free.app
```

No test suite exists. Verify changes manually via the running app or curl against the API.

## Architecture

**Backend** (`backend/`): FastAPI on port 8000
- `main.py` — All API routes, auth middleware, grading orchestration (SSE streaming), file browsing (local + S3)
- `llm_providers.py` — LLM provider implementations (OpenAI, Anthropic, Google Gemini, OpenRouter) and the `grade_sample()` method that formats prompts and parses JSON responses

**Frontend** (`frontend/`): React 19 + TypeScript + Vite + Tailwind on port 3000
- `App.tsx` — Root layout, auth state, selected sample state, resizable panel layout
- `hooks/useGrading.ts` — Grading lifecycle: pre-flight validation → SSE stream → progress tracking → error surfacing
- `hooks/useApi.ts` — Sample loading from backend
- `hooks/useUrlState.ts` — URL query params for shareable deep links
- `components/FileBrowser/` — S3 and local JSONL file browser
- `components/LeftPanel/` — Sample table with sorting, search, filtering, grade columns
- `components/RightPanel/` — Chat message viewer with quote highlighting, grades display, analysis charts
- `components/GradingPanel/` — Modal for configuring and running LLM grading jobs

**Proxy**: Vite proxies `/api/*` → `localhost:8000`. SSE endpoint `/api/grade-stream` has special no-buffering config in `vite.config.ts`.

## Key Data Flow

1. User browses files via FileBrowser → selects a `.jsonl` file
2. Backend loads JSONL, returns samples via `GET /api/samples?file=...`
3. User selects samples in LeftPanel → views conversation in RightPanel
4. Grading: GradingPanel → `POST /api/test-provider` (pre-flight) → `POST /api/grade-stream` (SSE) → backend grades concurrently with semaphore-bounded parallelism → streams progress → frontend updates in real-time
5. Grades saved to `viz/` subdirectory alongside originals (never mutates source files)

## Configuration

All config is read from `~/.env` (home directory). The backend parses this file directly — it does NOT use `os.getenv()` or shell environment variables.

```
VIZ_PASSWORD=...           # Enables password auth (optional)
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=...
AWS_ACCESS_KEY_ID=...      # For S3 file browsing
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=...
```

## Important Patterns

- **OpenAI reasoning models** (o1, o3, o4-mini): Do not support `response_format`, `temperature`, or `top_p`. Use `max_completion_tokens` instead of `max_tokens`. See `_is_reasoning_model()` in `llm_providers.py`.
- **Grading concurrency**: Uses `asyncio.Semaphore` to bound parallel LLM calls. Do not use `asyncio.as_completed` with a sliding window — it silently drops tasks added during iteration.
- **Auth cookie**: `secure` flag is auto-set based on whether the request comes from localhost (HTTP) or not (HTTPS). See login endpoint in `main.py`.
- **Tunnel hosts**: When adding a new tunnel service, add its domain pattern to `server.allowedHosts` in `frontend/vite.config.ts`.
- **Custom metrics**: Stored in `custom_metrics.json` at project root. Preset metrics are hardcoded in `main.py`.

## JSONL Data Format

Each line in a `.jsonl` file is a sample with this structure:
```json
{
  "messages": [{"role": "user"|"assistant"|"system", "content": "..."}],
  "metadata_field": "...",
  "grades": {"metric_name": [{"grade": true, "quotes": [], "explanation": "...", "model": "gpt-4o", "timestamp": "..."}]}
}
```

See `docs/data_format.md` for the full schema and S3 setup guide.
