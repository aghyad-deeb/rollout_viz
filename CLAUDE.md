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

No test suite exists. Verify changes manually via the running app or curl against the API. FastAPI auto-docs available at `http://localhost:8000/docs`.

## Architecture

**Backend** (`backend/`): FastAPI on port 8000
- `main.py` — All API routes, auth middleware, grading orchestration (SSE streaming), file browsing (local + S3)
- `llm_providers.py` — LLM provider implementations (OpenAI, Anthropic, Google Gemini, OpenRouter) and the `grade_sample()` method that formats prompts and parses JSON responses

**Frontend** (`frontend/`): React 19 + TypeScript + Vite + Tailwind v4 on port 3000
- `App.tsx` — Root layout, auth state, selected sample state, resizable panel layout. All top-level state lives here (no Redux/Zustand/Context).
- `hooks/useGrading.ts` — Grading lifecycle: pre-flight validation → SSE stream → progress tracking → error surfacing
- `hooks/useApi.ts` — Sample loading from backend
- `hooks/useUrlState.ts` — URL query params for shareable deep links
- `components/FileBrowser/` — S3 and local JSONL file browser
- `components/LeftPanel/` — Sample table with sorting, search, filtering, grade columns
- `components/RightPanel/` — Chat message viewer with quote highlighting, grades display, analysis charts
- `components/GradingPanel/` — Modal for configuring and running LLM grading jobs

**Proxy**: Vite proxies `/api/*` → `localhost:8000`. SSE endpoint `/api/grade-stream` is listed separately before the catch-all `/api` proxy rule (order matters) and has a special `configure` handler in `vite.config.ts` that injects `cache-control: no-cache` and `x-accel-buffering: no` headers to prevent SSE buffering.

## Key Data Flow

1. User browses files via FileBrowser → selects a `.jsonl` file
2. Backend loads JSONL, returns samples via `GET /api/samples?file=...`
3. User selects samples in LeftPanel → views conversation in RightPanel
4. Grading: GradingPanel → `POST /api/test-provider` (pre-flight) → `POST /api/grade-stream` (SSE) → backend grades concurrently with semaphore-bounded parallelism → streams progress → frontend updates in real-time
5. Grades saved to `viz/` subdirectory alongside originals (never mutates source files)

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Health check |
| `/api/auth/login` | POST | Login, sets `viz_session` cookie |
| `/api/auth/check` | GET | Returns `{auth_required, authenticated}` |
| `/api/files/local` | GET | Recursive JSONL listing in a local directory |
| `/api/files/s3` | GET | Recursive JSONL listing in S3 |
| `/api/contents/local` | GET | Non-recursive dir listing (folders + files) |
| `/api/contents/s3` | GET | Non-recursive S3 listing |
| `/api/samples` | GET | Load all samples from a JSONL file |
| `/api/sample/{id}` | GET | Load a single sample by index |
| `/api/preset-metrics` | GET | Built-in + saved custom metrics |
| `/api/save-custom-metric` | POST | Persist a custom metric to `custom_metrics.json` |
| `/api/custom-metric/{key}` | DELETE | Remove a custom metric |
| `/api/available-api-keys` | GET | Which providers have keys in `~/.env` |
| `/api/test-provider` | POST | Pre-flight check: one real API call |
| `/api/grade` | POST | Non-streaming grade (legacy, unused by frontend) |
| `/api/grade-stream` | POST | SSE streaming grade (used by frontend) |
| `/api/save-graded` | POST | Merge new grades into `viz/` file |

## Configuration

All config is read from `~/.env` (home directory). The backend parses this file directly into a private `_env_config` dict — it does NOT use `os.getenv()` or shell environment variables. Exception: AWS credentials are injected into `os.environ` because boto3 requires it.

```
VIZ_PASSWORD=...           # Enables password auth (optional)
VIZ_SECRET_KEY=...         # Signs session cookies. If absent, random key generated at startup (sessions invalidate on restart)
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=...
AWS_ACCESS_KEY_ID=...      # For S3 file browsing
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=...
```

## Important Patterns

### Backend
- **OpenAI reasoning models** (o1, o3, o4-mini): Do not support `response_format`, `temperature`, or `top_p`. Use `max_completion_tokens` instead of `max_tokens`. See `_is_reasoning_model()` in `llm_providers.py`.
- **Grading concurrency**: Uses `asyncio.Semaphore` to bound parallel LLM calls. Do not use `asyncio.as_completed` with a sliding window — it silently drops tasks added during iteration.
- **`validate` → `is_validate` rename**: The backend silently renames the `validate` attribute to `is_validate` on load to avoid shadowing Pydantic's `BaseModel.validate`. Raw JSONL uses `validate`; frontend uses `is_validate`.
- **`viz/` subdirectory**: When loading a file, the backend first checks for `viz/<filename>.jsonl` and uses it if present. Grading writes to this path. The `save-graded` endpoint merges (appends to each metric's grade list), never overwrites.
- **Path traversal protection**: `_safe_resolve_path()` ensures all file paths resolve within `PROJECT_ROOT`.
- **Auth rate limiting**: 5 failed login attempts per 5-minute window per IP, in-memory (resets on server restart).
- **SSE events**: Three types — `{type: "progress", completed, total}`, `{type: "complete", graded_count, errors, grades}`, `{type: "error", message}`.
- **Custom metrics**: Stored in `custom_metrics.json` at project root. Preset metrics (`helpfulness`, `accuracy`, `safety`, `coherence`, `task_completion`) are hardcoded in `llm_providers.py`.

### Frontend
- **Tailwind v4**: Uses `@tailwindcss/vite` plugin, not PostCSS. CSS import is `@import "tailwindcss"`, not a config file.
- **TypeScript strict mode** with `erasableSyntaxOnly: true` — no `enum` or `namespace` allowed. ESLint 9 flat config.
- **Message role colors**: Defined as hand-rolled CSS classes in `index.css` (`.message-user`, `.message-assistant`, etc.), NOT Tailwind classes. Adding a new message role requires adding CSS classes there.
- **Virtual scrolling**: `SampleTable.tsx` uses manual virtual scrolling with fixed `ROW_HEIGHT = 36px`. Changing row height requires reworking the scroll logic.
- **Two search systems**: (1) Global search in FilterBar — multi-condition AND/OR, field-scoped, yellow/orange highlights. (2) Local search in ChatView (`Ctrl+F`) — in-message text search, green highlights. These are independent.
- **Filter expression mini-language**: Supports `==, !=, >, <, >=, <=, contains` with autocomplete. Grade metrics are queryable by name (e.g., `helpfulness > 0.7`). Parsed in `LeftPanel/index.tsx`.
- **Highlight priority** in MessageCard: URL highlight (blue, animated) > Grade quotes (purple) > Local search (green) > Global search (yellow/orange).
- **URL deep links**: Params are `?file=<path>&rollout=<rollout_n>&message=<index>&highlight=<text>`. `rollout` uses `rollout_n` from attributes (not sequential ID). Updates via `replaceState` (no history push).
- **Multi-file loading**: Files fetched in parallel via `Promise.all`. Sample IDs reassigned sequentially. Each sample gets a `source_file` attribute injected by the frontend.
- **Auth cookie**: `secure` flag is auto-set based on whether the request comes from localhost (HTTP) or not (HTTPS).
- **Tunnel hosts**: When adding a new tunnel service, add its domain pattern to `server.allowedHosts` in `frontend/vite.config.ts`.
- **LocalStorage keys**: `rollout_viz_api_keys`, `rollout_viz_last_provider`, `rollout_viz_last_model`, `rollout_viz_dark_mode`, `rollout_viz_marked_files`.

### Unimplemented UI
Several buttons are placeholders: Cut/Edit on MessageCard, Download in NavigationBar, Eval/Meta view modes (show "coming soon"). Only `chat` and `analysis` view modes are functional.

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
