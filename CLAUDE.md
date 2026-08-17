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

## Testing

This project follows **Red/Green TDD**: write a failing test with timing/behavior assertions first, then implement the minimum code to make it pass.

### Running Tests

```bash
# Backend (pytest + pytest-benchmark + moto for S3 mocking)
source venv/bin/activate
pytest tests/ -v                                    # Full suite (~450 tests)
pytest tests/test_performance.py -v                 # Performance benchmarks
pytest tests/test_llm_providers.py -v               # LLM provider unit tests
pytest tests/test_performance.py -k "s3_client" -v  # Run specific test class

# Frontend (vitest + @testing-library/react)
cd frontend
npx vitest run                                      # Full suite (~780 tests)
npx vitest run src/hooks/useDebouncedValue.test.ts   # Single file
npx vitest run src/components/LeftPanel/             # Directory
npx vitest                                          # Watch mode
```

### Test Organization

**Backend** (`tests/`):
- `conftest.py` — Shared fixtures: `sample_data`, `temp_jsonl`, `patch_project_root`, `app_no_auth`, `app_with_auth`, `authenticated_client`, `mock_s3`, `mock_env_config`. Autouse fixture resets rate limiter + caches between tests.
- `test_performance.py` — Performance benchmarks with timing assertions (`@pytest.mark.performance`): S3 singleton, GZip, file cache, viz_exists cache, load benchmarks.
- `test_llm_providers.py` — Provider factory, prompt building, response parsing, Google client reuse.
- `test_sample_loading.py` — Sample loading, attribute defaults, `validate` → `is_validate` rename.
- `test_file_browsing.py` — Local and S3 file listing, path traversal protection.
- `test_grading.py` — Grade saving, merging, viz/ directory handling.
- `test_auth.py` — Auth middleware, login, rate limiting, cookie handling.
- `test_startup_stress.py` — Sustained load and memory pressure tests (slow, may flake under CI load).

**Frontend** (`frontend/src/**/*.test.{ts,tsx}`):
- `hooks/useDebouncedValue.test.ts` — Debounce hook: initial value, delay, timer reset.
- `hooks/useDarkMode.test.ts`, `hooks/useMarkedFiles.test.ts`, `hooks/useUrlState.test.ts` — Hook unit tests.
- `components/RightPanel/MessageCard.test.tsx` — Rendering, role colors, highlight priority, React.memo verification.
- `components/RightPanel/ChatView.test.tsx`, `components/RightPanel/GradesDisplay.test.tsx` — Right panel unit tests.
- `components/LeftPanel/SampleTable.test.tsx` — Table rendering, column sorting, selection.
- `components/LeftPanel/SampleTable.stress.test.tsx` — 5,000-sample virtual scrolling, RAF scroll throttle, grade columns at scale.
- `components/LeftPanel/LeftPanel.stress.test.tsx` — 5,000-sample filtering/sorting, debounced search batching, AND/OR logic.
- `test/fixtures.ts` — `makeSample()`, `makeMessage()`, `makeAttributes()`, `makeGradeEntry()` factory helpers.
- `test/setup.ts` — Global test setup (jsdom polyfills).

### Writing New Tests (Red/Green TDD)

1. **RED**: Write the failing test first. Use timing assertions for performance tests (e.g., `assert elapsed < 0.05`). Use identity checks for singletons (`assert client1 is client2`). Use `vi.useFakeTimers()` for debounce tests.
2. **GREEN**: Write the minimum implementation to make the test pass.
3. **REFACTOR**: Clean up without breaking green.

Key patterns:
- Backend perf tests use `time.perf_counter()` for timing, `@pytest.mark.performance` marker.
- Frontend stress tests generate 5,000 samples via helper functions and assert render/filter times.
- Use `_reset_*()` / `_clear_*()` functions for cache teardown in tests (called by autouse fixture in conftest).
- Frontend tests requiring debounce use `vi.useFakeTimers()` + `act(() => vi.advanceTimersByTime(200))`.

FastAPI auto-docs available at `http://localhost:8000/docs`.

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
| `/api/rollout` | GET | Canonical single-rollout fetch for machine consumers (`url=` or `file=`+`index=`/`rollout=`; `format=plaintext` has exactly ONE format/truncation policy — per-caller options are refused by design). Resolves the viz/ overlay. Lives in `backend/fetch_api.py` |
| `/api/config` | GET | Non-secret cross-app wiring (`web_chat_base_url`) |
| `/api/library` | GET | Landing-page corpus index: kinds→groups→files from ONE cached S3 listing (900s TTL, stale-while-revalidate, boot warmup; no crawler/daemon). `backend/library_api.py` |
| `/api/library/preview` | GET | Lazy first-line preview of one file (256KB ranged GET) |
| `/api/companion` | GET | Companion files (plan.md/summary.json/execution.jsonl) next to a loaded file. `backend/companion_api.py` |
| `/api/raw` | GET | Raw text of a companion file (2MB cap, extension allowlist, traversal-guarded) |

## Configuration

All config is read from `~/.env` (home directory). The backend parses this file directly into a private `_env_config` dict — it does NOT use `os.getenv()` or shell environment variables. AWS credentials are passed directly to `boto3.Session()` from `_env_config`, not via `os.environ`.

```
VIZ_PASSWORD=...           # Enables password auth (optional)
VIZ_SECRET_KEY=...         # Signs session cookies. If absent, random key generated at startup (sessions invalidate on restart)
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=...
VIZ_API_TOKEN=...          # Machine auth: Authorization: Bearer <token> == full access (web_chat/auto_eval/skills call the fetch API with it)
VIZ_FILE_CACHE_MB=4096     # Byte budget for the parsed-file cache (raw bytes; default 4096)
VIZ_LIBRARY_BUCKET=...     # Bucket the Library landing view lists (default rewardseeker)
VIZ_LIBRARY_WARMUP=1       # Boot-time background Library scan (default on)
WEB_CHAT_BASE_URL=...      # Enables the "Open in web_chat" action (unset = hidden)
AWS_ACCESS_KEY_ID=...      # For S3 file browsing
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=...
```

## Important Patterns

### Backend
- **viz_writer package** (`viz_writer/`, editable-installed in the shared venv): THE blessed writer for producers — permissive validation, lossless passthrough, stamps `attributes.viz_id`, never fabricates reward/step/sample_index, returns canonical `?file&index` URLs. Single-writer-per-file contract for S3 append (conditional puts turn races into loud errors).
- **Machine auth**: `Authorization: Bearer <VIZ_API_TOKEN>` == full access (checked in auth_middleware step 1.5, bytes compare_digest, case-insensitive scheme, explicit 401 on mismatch). Consumers discover the token from `ROLLOUT_VIZ_TOKEN` env or the `VIZ_API_TOKEN` line in `~/.env`.
- **File cache is byte-capped**: `_cache_put()` centralizes insert+evict (FIFO, 20 entries AND `VIZ_FILE_CACHE_MB` raw bytes) under a lock — loaders run in threadpools, unlocked eviction raced. Reads use `.get()` (atomic), entries are `(validator, data, nbytes)` 3-tuples.
- **New routers go in new modules** (`fetch_api.py`, `library_api.py`, `companion_api.py`), included at the BOTTOM of main.py BEFORE the static-file catch-all (routes registered after it are dead). They import `backend.main` at call time, not module level (import-order trap).
- **Library is listing-derived only**: one S3 listing pass (≈90s cold on the real bucket → 900s TTL + stale-while-revalidate + boot warmup + single-flight). No crawler, no daemon, no per-file HEADs. Hardcoded prefix→kind map.
- **Tinker message reconstruction**: `backend/message_reconstruction.py` decomposes tinker_rl-serialized assistant turns (`<|content_thinking|>` / `<|content_invoke_tool_json|>` / `<|content_text|>` token grammar) into `reasoning`/`content`/`tool_calls` at serving time — hooked in all three sample-building sites in main.py AND in `_format_target_conversation` (llm_providers.py) so LLM judges never see token soup. Original string preserved in `raw_content`; `raw_jsonl_entry` stays untouched; a `diagnostics[]` note surfaces the amber diag pill. Bail-out-on-unknown-segment, idempotent, never raises. Tests: `tests/test_message_reconstruction.py`.
- **S3 client singleton**: `_get_s3_client()` lazily creates one `boto3.client('s3')` and reuses it across all S3 operations. Call `_reset_s3_client()` in tests to force re-creation (e.g., inside `mock_aws` context). All 5 S3 functions use this — never call `boto3.client('s3')` directly.
- **GZip compression**: `GZipMiddleware(minimum_size=1000)` compresses API responses over 1KB. Added after CORS middleware.
- **File loading cache**: `load_jsonl_from_file()` caches parsed results keyed by `(path, mtime)`. FIFO eviction at 20 entries. Call `_clear_file_cache()` in tests. Invalidates automatically when file mtime changes.
- **viz_exists TTL cache**: `viz_file_exists()` caches results for 60 seconds to avoid repeated `head_object` / `stat()` calls. Call `_clear_viz_exists_cache()` in tests.
- **LLM provider client reuse**: All providers (OpenAI, Anthropic, Google, OpenRouter) cache their API client in `self._client` via `_get_client()`. Google previously called `genai.configure()` + `GenerativeModel()` on every sample — now cached like the others.
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
- **Debounced filtering**: `LeftPanel/index.tsx` uses `useDebouncedValue(value, 150)` on `searchConditions` and `filterExpression` before passing them to the `filteredSamples` useMemo. This prevents O(n*m) re-filtering on every keystroke. The hook lives at `hooks/useDebouncedValue.ts`.
- **React.memo on MessageCard**: `MessageCard` is wrapped in `React.memo()` to skip re-renders when props haven't changed. The inner function is `MessageCardInner`, the export is `memo(MessageCardInner)`.
- **RAF-throttled scroll**: `SampleTable.tsx` scroll handler uses `requestAnimationFrame` coalescing — stores a `rafIdRef`, skips if already scheduled, cleans up on unmount. Event listener uses `{ passive: true }`.
- **Lazy-loaded chunks**: `AnalysisView` (imports recharts ~385KB) is `React.lazy()` loaded in `RightPanel/index.tsx`. `GradingPanel` is `React.lazy()` loaded in `App.tsx`. Both wrapped in `<Suspense>` with spinner fallbacks.
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
- **Keyboard shortcuts**: `J`/`K` next/prev sample (global, suppressed while typing / in modals / presentation mode / rollout chat), `ArrowUp`/`ArrowDown` in the focused sample table, `Ctrl+F` in-chat search, `P` enters presentation mode (then per-card capture), `Escape` closes modals (FileBrowser, GradingPanel, capture preview) and exits Presentation Mode. The grading modal stays mounted after first open so Escape/backdrop dismissal never loses a drafted custom metric.
- **Degenerate ID column**: when every loaded sample shares one `sample_index` but `rollout_n` varies, the table's first column switches to `Rollout` (computed over the full sample list in `LeftPanel/index.tsx` as `idColumnKey`, so filtering never flips it).
- **Callback identity discipline**: ChatView's preview-capture effect reads its callbacks through refs, and object-valued optional props use hoisted module-level defaults (`EMPTY_DRAFTS`, `EMPTY_WRAP_SET`) — an inline `= {}` default or an unstable callback in that effect's deps re-arms a capture loop ("Updating preview…" forever). Regression-tested in `ChatView.test.tsx` ("live preview pipeline").
- **Rollout chat protection**: `RolloutChatPanel` reports dirtiness via `onDirtyChange`; App gates sample switches, chat close, and presentation-mode entry behind `window.confirm` while a discussion exists (the panel is keyed by sample id and remounts on switch).
- **Partial load failures**: the batch endpoint returns per-file `errors`; `useApi` exposes them as `loadWarnings` and LeftPanel shows a dismissible amber banner alongside the loaded samples (full-screen `error` is reserved for nothing-loaded).
- **Page title**: `utils/pageTitle.ts` `buildPageTitle()` keeps `document.title` in sync with the loaded experiment/file and selected rollout (wired in `App.tsx`).
- **Library landing view**: with no `?file` param the app renders `components/Library` instead of force-loading the demo file (kinds→groups→files, lazy previews on expand, "Load all" ≤20 files via multi-file loading). FileBrowser stays reachable via "Browse all files…".
- **Hidden default columns**: columns constant across ALL loaded samples AND equal to the schema default (reward 0, step 0/1, data_source "unknown") are hidden behind a visible "N columns hidden" pill (never silently); computed over the full sample list like `idColumnKey` so filtering can't flip it.
- **Hydration threshold**: bulk phase-2 message loading is skipped above 2,000 samples or 100MB raw (`total_raw_bytes` from the batch endpoint); a blue banner offers "Load all messages"; selected samples hydrate individually. Search only covers loaded messages until then.
- **Diag pill**: sample-level `diagnostics[]` (producer notes) pass through the backend and render as an amber "diag" pill in NavigationBar.
- **Image-capture contract** (broke silently in the 2026-08 redesign; keep these invariants): the off-screen portal capture card in ChatView is KEYED per active message and rendered with `forCapture` (forces expanded + unclamped regardless of role — system cards start collapsed on screen but must never export as header strips); `captureImage.ts scaleCard` scales widths (`width`/`min-width`/`max-width`/`flex-basis`, Typed-OM-discriminated) alongside fonts, or fixed gutters clip scaled labels; `.capture-export` in index.css force-opens `.message-body-grid`/`.message-body-clip`, hides `.collapsed-excerpt`, and releases `.role-label-gutter`/`.role-label-text` truncation; `CAPTURE_PAGE_BG` mirrors `--transcript-bg` (light `#f6f5f3`, dark `#0e1114`). Dark chrome runs off the neutral `--bg-primary/secondary/tertiary` trio (`#111418`/`#16191d`/`#1c2126`) — no navy literals; both drawers (Comments, CompanionDrawer) are flex siblings at sm+, never overlays.
- **Conversation minimap**: `RightPanel/Minimap.tsx` + `utils/minimapScale.ts` — a bare 10px strip (`w-2.5`, right: 6, `rounded-[2px]` blocks at 0.75 opacity with an inset hairline) overlaying ChatView's `relative` wrapper as a SIBLING of the scroll container (the Cmd+C `:scope > div` mapping forbids nesting). Log-scaled role-colored blocks (click → scroll to message, hover tooltip), RAF-throttled viewport indicator, ResizeObserver remeasure on collapse/resize, tick overlays for deep-link/quote/local/global search in MessageCard's highlight-priority order. Hidden in Presentation Mode and when the transcript fits on screen. The scroller reserves `pr-7` so cards never run under the rail.
- **Transcript readability conventions** (2026-08 three-lens audit, then the neutral-paper pass; keep these when touching MessageCard/ChatView): card surfaces are ONE neutral paper (`--card-paper`/`--card-border`/`--transcript-bg`/`--card-quiet` tokens in index.css) with role color only on the 3px left rail, an ~8% role tint on the header, and the role hue on the header LABEL (`.message-*-label`, deepened in light / lightened in dark for AA) — the user card is the single tinted body (mint) because it is the task; role-aware rhythm in ChatView (a tool result answering the assistant call above it gets `mt-1 ml-6` and a `↳ ` label prefix via `isChainedToolResult`, assistant turns `mt-7`, else `mt-4`); the FIRST user message is the task statement (`isTaskMessage` → 'TASK' running head, 16px/1.55 body) and system cards start COLLAPSED (deep link / current Ctrl+F match force-expand them, mirroring the showFull adjustment); headers are a scan-mode TOC — fixed `w-28` icon+label gutter, a right-aligned `w-10` line-count badge, a CSS-truncated excerpt (never a JS slice), a `#idx · N ln` meta run that swaps to the action buttons on hover, and the chevron parked at the far right; Inter + IBM Plex Mono via `@theme`; mono bodies (tool/file content, tool-call pre) are `text-[13px] leading-[20px]`, prose `max-w-[90ch] leading-6`, and reasoning renders at the SAME tier as answer prose (`text-sm leading-6` — user decision 2026-08-16: reasoning is evidence, never de-emphasize it below the final output); reasoning and tool-call blocks are borderless bands (2px `#f4a261` rule + 10px 'REASONING' label; 1px hairline + 'CALL · <name>'), never boxes; the long-card clamp is role-dependent (`max-h-36` system/file, `max-h-60` tool) and its control is a full-width FOOTER BAR ('Show N more lines ▾' / '▴ Collapse', gated on measured overflow) with a 24px fade above it; grade-quote marks are violet (user ephemeral highlights stay fuchsia) and dark-mode normal search marks are BRIGHT (`dark:bg-yellow-400`/`dark:bg-green-400`), not translucent; the `message.reasoning` field is honored by `normalizeAssistantMessage` (its MessageCard memo deps include it).
- **Open in web_chat**: NavigationBar shows a forum icon linking `${web_chat_base_url}/?chat=<s3key>&branch=<branch_id>` when the sample has `chat_id`, the file is under `s3://rewardseeker/`, and `/api/config` provides the base URL (`useServerConfig`, auth-gated fetch).
- **Run files drawer**: folder icon in NavigationBar → `CompanionDrawer` (companion list + inline md/json rendering; companion .jsonl files link OUT to a new viewer tab).
- **Canonical links**: `?file&index` is canonical (index-first resolution in App.tsx, share tokens carry index, copy-link dual-emits index+rollout+step); `?rollout=` stays supported forever for legacy links.
- **Human verdicts (Triage Mode)**: human annotations are ordinary `GradeEntry` rows appended to the same per-metric lists as LLM judges, distinguished by `model: "human:<name>"` (`utils/humanGrades.ts`; saved via the existing `POST /api/save-graded` merge — zero backend changes). Triage Mode (checklist toggle in NavigationBar) records verdicts under the `human_verdict` metric with keys 1-4 + optional note, auto-advancing to the next unreviewed sample in the filtered scope; annotator name persists in localStorage (`rollout_viz_annotator`). Judge-vs-human helpers: `latestHumanEntry` / `latestJudgeEntry`.
- **Comments**: per-rollout free-text comments ride the same human-annotation rails — `GradeEntry` rows with `grade_type: 'freeform'` (text in `grade`, `model: "human:<name>"`, `prompt_version: 'comment-v1'`) under the reserved `comments` metric (`COMMENTS_METRIC` in `utils/humanGrades.ts`), persisted via `applyHumanGrade` → `POST /api/save-graded` (append-only; no edit). UI: `RightPanel/CommentsPanel.tsx` drawer with the `sticky_note_2` glyph (never `forum`, which is the LLM discussion chat), toggled from NavigationBar (count badge + amber attention dot for an unposted draft / failed save, via the panel's `onAttentionChange`; hidden in shared mode). Open state is owned by **App** (`isCommentsOpen`) because the `fixed bottom-6 right-6` grading cluster must shift left of the 24rem drawer (`sm:right-[25.5rem]`, hidden below sm) or it swallows the Post button's clicks; RightPanel keeps the mounted latch (drawer hides, never unmounts, so per-sample drafts and Escape/X focus-return to the toggle survive) and lays the drawer out as a **flex sibling** of the content column (`sm:static sm:w-[24rem] sm:shrink-0`), so the transcript shrinks instead of being covered — full-width absolute overlay only below sm. `post()` consumes only the snapshot it sent, keeping text typed mid-flight. `comments` is a reserved NON-judgement metric: excluded from GradesDisplay, `buildGradeSummary` (hence Analysis tiles/count/inspector), and SampleTable's grade columns — the table gets a dedicated sortable `comment_count` column instead. It stays queryable in the filter mini-language.
- **Comment soft-delete (tombstones)**: the log is append-only, so deleting a comment appends a *tombstone* to the same `comments` list — `prompt_version: 'comment-delete-v1'`, empty `grade`, signed `model: "human:<deleter>"`, and a new optional `GradeEntry.deletes: {model, timestamp}` naming the retracted entry (one tombstone hides EVERY entry matching that pair; a tombstone with no target is inert). `visibleComments()` in `utils/humanGrades.ts` is **the one true reader** — the drawer list/header count, NavigationBar badge, SampleTable `comment_count` (count, tooltip, and column-presence), LeftPanel's sort case, and the filter mini-language's `comments` field all go through it; anything reading a comments list raw is a bug. Wired as `App.handleDeleteComment` → `buildCommentTombstone` → `applyHumanGrade`, threaded to CommentsPanel as `onDeleteComment` (undefined in shared mode). No backend change — `save-graded` passes the extra `deletes` key through. Per-card hover/focus delete button, `window.confirm` guard, requires a non-empty annotator (the tombstone is signed), no undo (history lives in the raw log).
- **Evidence view**: right-panel mode (`viewMode === 'evidence'`, view state owned by App) that renders every grader quote for one metric across the loaded corpus (`utils/evidence.ts` `buildEvidenceIndex`), with audit flags — `noEvidence` (judge saved no quotes) and `quoteNotFound` (quote text absent from the referenced message, i.e. possibly fabricated evidence) sort first. Confirm/Dispute on bool metrics appends a human entry to the SAME metric list (judge entry stays in run history). J/K in this view move the card cursor, so App's global J/K sample navigation is suppressed while it's active.

### Unimplemented UI
Eval/Meta view modes are disabled in the view-mode switcher ("Coming soon"); only `chat` and `analysis` view modes are functional. The former placeholder controls (Cut/Edit on MessageCard, the favourite star column, the inert LeftPanel header tabs) have been removed.

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
