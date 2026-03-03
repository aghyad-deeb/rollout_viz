# Benchmark & Optimize S3 Multi-File Loading

## Context

We have a batch endpoint (`POST /api/samples/batch`) that loads 8 S3 files (~17.6 MB each, ~155 MB total) using a flat ThreadPoolExecutor with 3 Range-request chunks per file. Current cold-cache performance is ~4.4s. We researched 10 optimization angles via subagents and identified 3 code-level wins (no infra/bucket changes needed). The user wants a rigorous benchmark-first approach: measure baseline, then apply each optimization one-by-one with measurements, then final comparison.

## Files to Modify

- `scripts/benchmark_s3_batch.py` — **New**: E2E benchmark script for 8-file S3 cold-cache loading
- `backend/main.py` — S3 client config, chunked download constants, socket options, connection pre-warming

## Step 0: Create E2E Benchmark Script

Create `scripts/benchmark_s3_batch.py` that:
1. Imports `_load_samples_batch_sync`, `_clear_file_cache`, `_clear_viz_exists_cache`, `_reset_s3_client` from `backend.main`
2. Clears all caches before each run (cold cache)
3. Calls `_load_samples_batch_sync(files)` with the 8 S3 file paths
4. Measures wall-clock time with `time.perf_counter()`
5. Runs 5 iterations, reports median/min/max and per-file breakdown
6. Prints total samples loaded and total MB downloaded

Run baseline benchmark and record the number.

## Step 1: Increase Chunks 3→5, Pool Connections 25→50

**What**: More parallel Range requests per file = higher aggregate bandwidth (S3 throttles per-connection). More pool connections to support 8 files × 5 chunks = 40 concurrent requests.

**Changes in `backend/main.py`**:
- Line 416: `_S3_DOWNLOAD_CHUNKS = 3` → `_S3_DOWNLOAD_CHUNKS = 5`
- Line 331: `max_pool_connections=25` → `max_pool_connections=50`

Run benchmark, record the number.

## Step 2: SO_KEEPALIVE + TCP Keepalive Socket Options

**What**: Enable TCP keepalive on the S3 client's connections so idle connections are detected as dead early rather than failing on first use. Also prevents the OS from closing idle connections.

**Changes in `_get_s3_client()` in `backend/main.py`**:
After `_s3_client = boto3.client('s3', config=s3_config)`, inject socket options:
```python
import socket
http_session = _s3_client._endpoint.http_session
http_session._manager.connection_pool_kw['socket_options'] = [
    (socket.IPPROTO_TCP, socket.TCP_NODELAY, 1),
    (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1),
    (socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60),
    (socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10),
    (socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 5),
]
```

Run benchmark, record the number.

## Step 3: Connection Pre-warming at Startup

**What**: Pre-establish TCP+TLS connections to S3 at server startup so the first batch request doesn't pay the TLS handshake cost.

**Changes in `backend/main.py`**:
- Add a `_prewarm_s3_connections(bucket)` function that sends N concurrent `head_bucket` calls to fill the urllib3 connection pool
- Integrate into the benchmark script (call prewarm before timed run to measure benefit)
- For the actual app: wire into FastAPI lifespan event if it shows measurable benefit

Run benchmark, record the number.

## Step 4: Final Comparison

Run the full benchmark with all optimizations applied, compare against baseline:
```
Baseline:     X.XXs
+Chunks 5:    X.XXs  (Δ ...)
+Keepalive:   X.XXs  (Δ ...)
+Prewarm:     X.XXs  (Δ ...)
```

## Verification

1. Run benchmark script 5× each step and use median to avoid noise
2. Run existing backend tests: `pytest tests/ -v` — all ~170 tests must pass
3. Run existing frontend tests: `cd frontend && npx vitest run` — all ~120 tests must pass
4. Manual test: load 8 files in the frontend UI, verify samples render correctly
