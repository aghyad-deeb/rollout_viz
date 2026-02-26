#!/usr/bin/env python3
"""
Benchmark script for measuring JSON parse + serialize performance.

Compares stdlib json vs orjson on realistic JSONL data, and measures
each stage of the /api/samples pipeline independently.

Usage:
    python -m scripts.benchmark_loading
    python -m scripts.benchmark_loading --generate-large  # create a ~50MB test file
"""

import json
import os
import sys
import time
import tempfile
from pathlib import Path

import orjson

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(PROJECT_ROOT))


SAMPLE_FILE = PROJECT_ROOT / "sample_rollout_traces.jsonl"


def generate_large_jsonl(path: Path, num_samples: int = 5000) -> None:
    """Generate a realistic JSONL file with ~4KB per sample."""
    print(f"  Generating {num_samples} samples to {path}...")
    with open(path, "w") as f:
        for i in range(num_samples):
            sample = {
                "messages": [
                    {"role": "system", "content": "You are a helpful AI assistant. " * 5},
                    {"role": "user", "content": f"Question {i}: " + "How do I solve this problem? " * 20},
                    {"role": "assistant", "content": f"Answer {i}: " + "Here is a detailed explanation of the solution. " * 40},
                ],
                "attributes": {
                    "step": i % 100,
                    "sample_index": i,
                    "rollout_n": i,
                    "reward": round((i % 100) * 0.01, 2),
                    "data_source": f"source/{i % 10}",
                    "experiment_name": f"experiment_{i % 5}",
                    "validate": i % 3 == 0,
                },
                "timestamp": "2026-01-15T10:00:00",
                "grades": {
                    "helpfulness": [
                        {"grade": True, "quotes": [f"quote {j}"], "explanation": f"Explanation {j}", "model": "gpt-4o", "timestamp": "2026-01-15T10:00:00"}
                        for j in range(3)
                    ],
                },
            }
            f.write(json.dumps(sample) + "\n")
    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"  Generated {size_mb:.1f} MB file")


def benchmark_parse(file_path: Path, label: str) -> list:
    """Benchmark JSON parsing: stdlib json vs orjson."""
    raw_bytes = file_path.read_bytes()
    lines = [l for l in raw_bytes.split(b"\n") if l.strip()]

    # --- stdlib json ---
    start = time.perf_counter()
    samples_json = [json.loads(line) for line in lines]
    elapsed_json = time.perf_counter() - start

    # --- orjson ---
    start = time.perf_counter()
    samples_orjson = [orjson.loads(line) for line in lines]
    elapsed_orjson = time.perf_counter() - start

    speedup = elapsed_json / elapsed_orjson if elapsed_orjson > 0 else float("inf")
    print(f"\n  [{label}] Parse {len(lines)} lines ({file_path.stat().st_size / 1024 / 1024:.1f} MB):")
    print(f"    json.loads:   {elapsed_json:.3f}s")
    print(f"    orjson.loads: {elapsed_orjson:.3f}s")
    print(f"    Speedup:      {speedup:.1f}x")
    return samples_orjson


def benchmark_serialize(samples: list, label: str) -> None:
    """Benchmark JSON serialization: stdlib json vs orjson."""
    # --- stdlib json ---
    start = time.perf_counter()
    json_output = json.dumps({"samples": samples, "total": len(samples)})
    elapsed_json = time.perf_counter() - start
    json_size = len(json_output)

    # --- orjson ---
    start = time.perf_counter()
    orjson_output = orjson.dumps({"samples": samples, "total": len(samples)})
    elapsed_orjson = time.perf_counter() - start
    orjson_size = len(orjson_output)

    speedup = elapsed_json / elapsed_orjson if elapsed_orjson > 0 else float("inf")
    print(f"\n  [{label}] Serialize {len(samples)} samples ({json_size / 1024 / 1024:.1f} MB output):")
    print(f"    json.dumps:   {elapsed_json:.3f}s")
    print(f"    orjson.dumps: {elapsed_orjson:.3f}s")
    print(f"    Speedup:      {speedup:.1f}x")


def benchmark_full_pipeline(file_path: Path, label: str) -> None:
    """Benchmark the full pipeline: parse → build samples → serialize response."""
    raw_bytes = file_path.read_bytes()
    lines = [l for l in raw_bytes.split(b"\n") if l.strip()]

    # --- BEFORE (stdlib json throughout) ---
    start = time.perf_counter()
    samples = [json.loads(line) for line in lines]
    t_parse = time.perf_counter() - start

    start = time.perf_counter()
    response_data = {"samples": samples, "total": len(samples), "experiment_name": "test", "file_path": str(file_path)}
    json_out = json.dumps(response_data)
    t_serialize = time.perf_counter() - start
    t_total_before = t_parse + t_serialize

    # --- AFTER (orjson throughout) ---
    start = time.perf_counter()
    samples2 = [orjson.loads(line) for line in lines]
    t_parse2 = time.perf_counter() - start

    start = time.perf_counter()
    response_data2 = {"samples": samples2, "total": len(samples2), "experiment_name": "test", "file_path": str(file_path)}
    orjson_out = orjson.dumps(response_data2)
    t_serialize2 = time.perf_counter() - start
    t_total_after = t_parse2 + t_serialize2

    speedup = t_total_before / t_total_after if t_total_after > 0 else float("inf")

    print(f"\n  [{label}] Full pipeline ({len(lines)} samples, {file_path.stat().st_size / 1024 / 1024:.1f} MB):")
    print(f"                     BEFORE (json)    AFTER (orjson)")
    print(f"    Parse:           {t_parse:.3f}s            {t_parse2:.3f}s")
    print(f"    Serialize:       {t_serialize:.3f}s            {t_serialize2:.3f}s")
    print(f"    Total:           {t_total_before:.3f}s            {t_total_after:.3f}s")
    print(f"    Speedup:         {speedup:.1f}x")
    print(f"    Output size:     {len(json_out) / 1024 / 1024:.1f} MB (json) vs {len(orjson_out) / 1024 / 1024:.1f} MB (orjson)")


def benchmark_cached_load() -> None:
    """Benchmark cached vs uncached loads using the actual backend cache."""
    from backend.main import load_jsonl_from_file, _clear_file_cache
    import backend.main as main_module

    if not SAMPLE_FILE.exists():
        print("\n  [Skipped] sample_rollout_traces.jsonl not found")
        return

    original = main_module.PROJECT_ROOT
    main_module.PROJECT_ROOT = SAMPLE_FILE.parent.resolve()
    try:
        _clear_file_cache()

        # Cold load
        start = time.perf_counter()
        result = load_jsonl_from_file(str(SAMPLE_FILE))
        cold = time.perf_counter() - start

        # Warm load (cached)
        start = time.perf_counter()
        result2 = load_jsonl_from_file(str(SAMPLE_FILE))
        warm = time.perf_counter() - start

        print(f"\n  [Cache] Backend load_jsonl_from_file ({len(result)} samples):")
        print(f"    Cold load:  {cold:.3f}s")
        print(f"    Warm load:  {warm * 1000:.3f}ms  ({cold / warm:.0f}x faster)")
    finally:
        main_module.PROJECT_ROOT = original


def main():
    print("=" * 70)
    print("  S3 Loading Speed Benchmark")
    print("=" * 70)

    # Benchmark with the existing sample file
    if SAMPLE_FILE.exists():
        samples = benchmark_parse(SAMPLE_FILE, "sample_rollout_traces")
        benchmark_serialize(samples, "sample_rollout_traces")
        benchmark_full_pipeline(SAMPLE_FILE, "sample_rollout_traces")
    else:
        print(f"\n  [Skipped] {SAMPLE_FILE} not found")

    # Generate and benchmark a larger file
    with tempfile.TemporaryDirectory() as tmpdir:
        large_file = Path(tmpdir) / "large_benchmark.jsonl"
        generate_large_jsonl(large_file, num_samples=5000)
        samples = benchmark_parse(large_file, "5000-sample")
        benchmark_serialize(samples, "5000-sample")
        benchmark_full_pipeline(large_file, "5000-sample")

    # Benchmark cached loads
    benchmark_cached_load()

    print("\n" + "=" * 70)
    print("  Done")
    print("=" * 70)


if __name__ == "__main__":
    main()
