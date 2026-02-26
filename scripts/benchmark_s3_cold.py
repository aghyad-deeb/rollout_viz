#!/usr/bin/env python3
"""
Benchmark cold-read latency for S3 files from the frontend's perspective.

Hits the Vite dev server (port 3000) which proxies to the backend — measuring
the same path the browser takes: HTTP request → Vite proxy → backend downloads
from S3 (no cache) → parses JSONL → serializes → proxy → HTTP response received.

When multiple files are selected, the frontend sends a single POST to
/api/samples/batch — the backend downloads all files in parallel. This is
the default (and realistic) benchmark mode.

The --include-individual flag adds a synthetic per-file sequential test for
comparison, but that is NOT what users experience.

Prerequisites:
    - Frontend dev server running on http://localhost:3000 (npm run dev)
    - Backend running on http://localhost:8000
    - S3 credentials configured in ~/.env

Usage:
    python -m scripts.benchmark_s3_cold                    # realistic batch test
    python -m scripts.benchmark_s3_cold --metadata-only    # metadata-only (fast phase)
    python -m scripts.benchmark_s3_cold --runs 3           # average over 3 runs
    python -m scripts.benchmark_s3_cold --include-individual  # also test one-by-one
    python -m scripts.benchmark_s3_cold --base-url http://localhost:8000  # skip proxy
"""

import argparse
import sys
import time
from pathlib import Path
from typing import Optional

import httpx


S3_FILES = [
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w160813.jsonl",
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w182467.jsonl",
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w198117.jsonl",
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w156683.jsonl",
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w199800.jsonl",
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w146534.jsonl",
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w128744.jsonl",
    "s3://rewardseeker/logs_jsonl/rollout_traces/test_slurm/32b_tp4_pp1_block-recompute-48-num-layers-/2026-02-23/step_52_w144694.jsonl",
]


def clear_cache(client: httpx.Client) -> None:
    """Clear all backend caches to ensure cold reads."""
    resp = client.post("/api/debug/clear-cache")
    resp.raise_for_status()


def check_health(client: httpx.Client) -> None:
    """Verify the backend is running."""
    try:
        resp = client.get("/api/health")
        resp.raise_for_status()
    except httpx.ConnectError:
        print("ERROR: Cannot connect to backend. Is it running?")
        sys.exit(1)


def authenticate(client: httpx.Client, password: Optional[str] = None) -> None:
    """Log in if auth is required. Reads password from ~/.env if not provided."""
    resp = client.get("/api/auth/check")
    data = resp.json()
    if not data.get("auth_required"):
        return
    if data.get("authenticated"):
        return

    if not password:
        env_file = Path.home() / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if line.startswith("VIZ_PASSWORD="):
                    password = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not password:
        print("ERROR: Auth required but no password found. Set VIZ_PASSWORD in ~/.env")
        sys.exit(1)

    resp = client.post("/api/auth/login", json={"password": password})
    if resp.status_code != 200:
        print(f"ERROR: Login failed: {resp.text}")
        sys.exit(1)
    print("  Authenticated successfully.")


def short_name(path: str) -> str:
    """Extract just the filename from an S3 path."""
    return path.rsplit("/", 1)[-1]


def fmt_size(num_bytes: int) -> str:
    """Format bytes as human-readable."""
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / 1024 / 1024:.1f} MB"
    return f"{num_bytes / 1024:.0f} KB"


def benchmark_batch(client: httpx.Client, runs: int = 1, metadata_only: bool = False) -> Optional[dict]:
    """Benchmark loading all files in one batch via POST /api/samples/batch.

    This is what the frontend actually does — a single request that triggers
    parallel S3 downloads on the backend.

    When metadata_only=True, sends metadata_only: true in the request body,
    which omits message content (the fast first phase of two-phase loading).
    """
    timings = []
    payload: dict = {"files": S3_FILES}
    if metadata_only:
        payload["metadata_only"] = True

    for run in range(runs):
        clear_cache(client)

        start = time.perf_counter()
        resp = client.post("/api/samples/batch", json=payload)
        elapsed = time.perf_counter() - start

        if resp.status_code != 200:
            print(f"  ERROR: {resp.status_code} - {resp.text[:200]}")
            continue

        data = resp.json()
        total_samples = data.get("total", len(data.get("samples", [])))
        errors = data.get("errors", [])
        file_results = data.get("file_results", [])

        timings.append({
            "elapsed": elapsed,
            "samples": total_samples,
            "response_bytes": len(resp.content),
            "errors": errors,
            "file_results": file_results,
        })

        run_label = f"Run {run + 1}/{runs}: " if runs > 1 else ""
        print(f"  {run_label}{elapsed:.2f}s  |  "
              f"{total_samples} samples  |  "
              f"{fmt_size(len(resp.content))}")

    if not timings:
        return None

    avg_elapsed = sum(t["elapsed"] for t in timings) / len(timings)
    result = {
        "avg_time": avg_elapsed,
        "min_time": min(t["elapsed"] for t in timings),
        "max_time": max(t["elapsed"] for t in timings),
        "samples": timings[0]["samples"],
        "response_size": timings[0]["response_bytes"],
        "errors": timings[0]["errors"],
        "file_results": timings[0]["file_results"],
        "runs": len(timings),
        "files": len(S3_FILES),
    }

    if runs > 1:
        print(f"\n  Average: {avg_elapsed:.2f}s  "
              f"(min {result['min_time']:.2f}s, max {result['max_time']:.2f}s)")

    if result["errors"]:
        print(f"\n  Errors ({len(result['errors'])}):")
        for err in result["errors"]:
            print(f"    - {short_name(err['file'])}: {err['error']}")

    if result["file_results"]:
        print(f"\n  Per-file sample counts:")
        for fr in result["file_results"]:
            print(f"    {short_name(fr['file']):<32s}  {fr['count']} samples")

    return result


def benchmark_individual(client: httpx.Client, runs: int = 1) -> list[dict]:
    """Benchmark loading each file one at a time via GET /api/samples.

    NOTE: This is NOT what users experience — the frontend uses the batch
    endpoint. This is included only for comparison.
    """
    results = []

    for file_path in S3_FILES:
        name = short_name(file_path)
        timings = []

        for run in range(runs):
            clear_cache(client)

            start = time.perf_counter()
            resp = client.get("/api/samples", params={"file": file_path})
            elapsed = time.perf_counter() - start

            if resp.status_code != 200:
                print(f"  ERROR {name}: {resp.status_code} - {resp.text[:200]}")
                continue

            data = resp.json()
            timings.append({
                "elapsed": elapsed,
                "samples": data.get("total", len(data.get("samples", []))),
                "response_bytes": len(resp.content),
            })

        if timings:
            avg_elapsed = sum(t["elapsed"] for t in timings) / len(timings)
            result = {
                "file": name,
                "avg_time": avg_elapsed,
                "min_time": min(t["elapsed"] for t in timings),
                "max_time": max(t["elapsed"] for t in timings),
                "samples": timings[0]["samples"],
                "response_size": timings[0]["response_bytes"],
                "runs": len(timings),
            }
            results.append(result)

            if runs == 1:
                print(f"  {name:<30s}  {avg_elapsed:6.2f}s  "
                      f"{result['samples']:>5d} samples  "
                      f"{fmt_size(result['response_size']):>8s}")
            else:
                print(f"  {name:<30s}  avg {avg_elapsed:6.2f}s  "
                      f"(min {result['min_time']:.2f}s, max {result['max_time']:.2f}s)  "
                      f"{result['samples']:>5d} samples  "
                      f"{fmt_size(result['response_size']):>8s}")

    return results


def main():
    parser = argparse.ArgumentParser(description="Benchmark cold S3 file loading")
    parser.add_argument("--base-url", default="http://localhost:3000",
                        help="Base URL (default: http://localhost:3000 via Vite proxy)")
    parser.add_argument("--runs", type=int, default=1,
                        help="Number of runs per test for averaging (default: 1)")
    parser.add_argument("--metadata-only", action="store_true",
                        help="Benchmark metadata-only loading (fast first phase, no messages)")
    parser.add_argument("--include-individual", action="store_true",
                        help="Also run per-file sequential tests (not the real user path)")
    parser.add_argument("--timeout", type=float, default=120.0,
                        help="HTTP timeout in seconds (default: 120)")
    args = parser.parse_args()

    client = httpx.Client(
        base_url=args.base_url,
        timeout=httpx.Timeout(args.timeout, connect=10.0),
    )

    print("=" * 78)
    print("  S3 Cold-Read Benchmark (frontend perspective)")
    print(f"  URL: {args.base_url}  |  Files: {len(S3_FILES)}  |  Runs: {args.runs}")
    print("=" * 78)

    check_health(client)
    authenticate(client)
    print("  Backend is healthy.\n")

    # --- Metadata-only batch load (if requested) ---
    meta_result = None
    if args.metadata_only:
        print("-" * 78)
        print("  Metadata-only batch load — fast first phase (no messages)")
        print("  (POST /api/samples/batch, metadata_only=true, cold cache)")
        print("-" * 78)
        meta_result = benchmark_batch(client, runs=args.runs, metadata_only=True)
        print()

    # --- Batch load (the real user experience) ---
    print("-" * 78)
    print("  Full batch load — what users experience (background phase)")
    print("  (POST /api/samples/batch, cold cache, parallel S3 downloads)")
    print("-" * 78)
    batch_result = benchmark_batch(client, runs=args.runs)
    print()

    # --- Optional: individual file loads for comparison ---
    individual_results = []
    if args.include_individual:
        print("-" * 78)
        print("  Individual file loads — for comparison only (NOT the real user path)")
        print("  (GET /api/samples, cold cache, sequential)")
        print("-" * 78)
        individual_results = benchmark_individual(client, runs=args.runs)

        if individual_results:
            total_time = sum(r["avg_time"] for r in individual_results)
            total_samples = sum(r["samples"] for r in individual_results)
            total_size = sum(r["response_size"] for r in individual_results)
            print(f"\n  {'TOTAL (sequential)':<30s}  {total_time:6.2f}s  "
                  f"{total_samples:>5d} samples  "
                  f"{fmt_size(total_size):>8s}")
        print()

    # --- Summary ---
    if batch_result or meta_result:
        print("=" * 78)
        print("  Result")
        print("=" * 78)

        if meta_result:
            print(f"  Metadata-only (cold):   {meta_result['avg_time']:.2f}s")
            print(f"    Payload:              {fmt_size(meta_result['response_size'])}")
            print(f"    Samples:              {meta_result['samples']}")

        if batch_result:
            print(f"  Full load (cold):       {batch_result['avg_time']:.2f}s")
            print(f"    Payload:              {fmt_size(batch_result['response_size'])}")
            print(f"    Files:                {batch_result['files']}")
            print(f"    Samples:              {batch_result['samples']}")

        if meta_result and batch_result:
            speedup = batch_result["avg_time"] / meta_result["avg_time"] if meta_result["avg_time"] > 0 else float("inf")
            size_ratio = batch_result["response_size"] / meta_result["response_size"] if meta_result["response_size"] > 0 else float("inf")
            print(f"\n  Metadata-only speedup:  {speedup:.1f}x faster")
            print(f"  Payload reduction:      {size_ratio:.0f}x smaller")

        if individual_results and batch_result:
            seq_total = sum(r["avg_time"] for r in individual_results)
            speedup = seq_total / batch_result["avg_time"] if batch_result["avg_time"] > 0 else float("inf")
            print(f"\n  vs sequential:          {seq_total:.2f}s ({speedup:.1f}x slower)")
            slowest = max(individual_results, key=lambda r: r["avg_time"])
            fastest = min(individual_results, key=lambda r: r["avg_time"])
            print(f"  Slowest single file:    {slowest['file']} ({slowest['avg_time']:.2f}s)")
            print(f"  Fastest single file:    {fastest['file']} ({fastest['avg_time']:.2f}s)")

    print()
    print("=" * 78)
    print("  Done")
    print("=" * 78)

    client.close()


if __name__ == "__main__":
    main()
