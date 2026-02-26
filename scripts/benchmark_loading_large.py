#!/usr/bin/env python3
"""
Benchmark with a ~100MB JSONL file to match the real-world scenario from the plan.

Usage:
    cd /data2/Users/aghyad/reward_seeker/rollout_viz
    source venv/bin/activate
    python -m scripts.benchmark_loading_large
"""

import json
import sys
import time
import tempfile
from pathlib import Path

import orjson

PROJECT_ROOT = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(PROJECT_ROOT))


def generate_100mb_jsonl(path: Path) -> int:
    """Generate a ~100MB JSONL file with realistic conversation data."""
    print("Generating ~100 MB JSONL file...")
    count = 0
    with open(path, "w") as f:
        while path.stat().st_size < 100 * 1024 * 1024 if path.exists() else True:
            sample = {
                "messages": [
                    {"role": "system", "content": "You are a helpful AI assistant specialized in providing detailed, accurate, and comprehensive responses. " * 3},
                    {"role": "user", "content": f"Sample {count}: " + "Please explain the concept in great detail, covering all relevant aspects and providing examples where appropriate. " * 15},
                    {"role": "assistant", "content": f"Response {count}: " + "I'll provide a comprehensive explanation covering multiple aspects of this topic. Here is a thorough analysis with examples and detailed reasoning that should help you understand the concept fully. " * 30},
                ],
                "attributes": {
                    "step": count % 200,
                    "sample_index": count,
                    "rollout_n": count,
                    "reward": round((count % 100) * 0.01, 2),
                    "data_source": f"source/{count % 20}",
                    "experiment_name": f"experiment_{count % 10}",
                    "validate": count % 3 == 0,
                },
                "timestamp": "2026-01-15T10:00:00",
                "grades": {
                    "helpfulness": [
                        {"grade": True, "quotes": [f"This is a relevant quote from the response number {j}"], "explanation": f"The response demonstrates helpfulness by providing detailed and accurate information {j}", "model": "gpt-4o", "timestamp": "2026-01-15T10:00:00"}
                        for j in range(2)
                    ],
                },
            }
            f.write(json.dumps(sample) + "\n")
            count += 1
            # Check size every 100 samples
            if count % 100 == 0 and path.stat().st_size >= 100 * 1024 * 1024:
                break

    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"Generated {count} samples, {size_mb:.1f} MB\n")
    return count


def run_benchmark(file_path: Path) -> None:
    raw_bytes = file_path.read_bytes()
    lines = [l for l in raw_bytes.split(b"\n") if l.strip()]
    file_size_mb = len(raw_bytes) / (1024 * 1024)

    print(f"File: {file_size_mb:.1f} MB, {len(lines)} lines")
    print("-" * 65)

    # --- Parse ---
    start = time.perf_counter()
    samples_json = [json.loads(line) for line in lines]
    t_parse_json = time.perf_counter() - start

    start = time.perf_counter()
    samples_orjson = [orjson.loads(line) for line in lines]
    t_parse_orjson = time.perf_counter() - start

    # --- Serialize (simulates JSONResponse vs ORJSONResponse) ---
    response_payload = {"samples": samples_json, "total": len(samples_json), "experiment_name": "test", "file_path": "test.jsonl"}

    start = time.perf_counter()
    json_out = json.dumps(response_payload)
    t_ser_json = time.perf_counter() - start

    response_payload2 = {"samples": samples_orjson, "total": len(samples_orjson), "experiment_name": "test", "file_path": "test.jsonl"}

    start = time.perf_counter()
    orjson_out = orjson.dumps(response_payload2)
    t_ser_orjson = time.perf_counter() - start

    # --- Full pipeline ---
    t_total_before = t_parse_json + t_ser_json
    t_total_after = t_parse_orjson + t_ser_orjson

    # --- GZip comparison ---
    import gzip
    start = time.perf_counter()
    gzip_json = gzip.compress(json_out.encode())
    t_gzip_json = time.perf_counter() - start

    start = time.perf_counter()
    gzip_orjson = gzip.compress(orjson_out)
    t_gzip_orjson = time.perf_counter() - start

    t_e2e_before = t_total_before + t_gzip_json
    t_e2e_after = t_total_after + t_gzip_orjson

    # --- Results ---
    print(f"{'Stage':<22} {'BEFORE (json)':>15} {'AFTER (orjson)':>15} {'Speedup':>10}")
    print(f"{'─' * 22} {'─' * 15} {'─' * 15} {'─' * 10}")
    print(f"{'Parse JSONL':<22} {t_parse_json:>14.3f}s {t_parse_orjson:>14.3f}s {t_parse_json / t_parse_orjson:>9.1f}x")
    print(f"{'Serialize response':<22} {t_ser_json:>14.3f}s {t_ser_orjson:>14.3f}s {t_ser_json / t_ser_orjson:>9.1f}x")
    print(f"{'  Subtotal (Python)':<22} {t_total_before:>14.3f}s {t_total_after:>14.3f}s {t_total_before / t_total_after:>9.1f}x")
    print(f"{'GZip compress':<22} {t_gzip_json:>14.3f}s {t_gzip_orjson:>14.3f}s {t_gzip_json / t_gzip_orjson:>9.1f}x")
    print(f"{'─' * 22} {'─' * 15} {'─' * 15} {'─' * 10}")
    print(f"{'Total end-to-end':<22} {t_e2e_before:>14.3f}s {t_e2e_after:>14.3f}s {t_e2e_before / t_e2e_after:>9.1f}x")
    print()
    print(f"Output size: {len(json_out) / 1024 / 1024:.1f} MB → gzipped {len(gzip_json) / 1024 / 1024:.1f} MB")
    print(f"Time saved per request: {t_e2e_before - t_e2e_after:.2f}s")

    # --- Cache benefit ---
    print(f"\n{'─' * 65}")
    print("Cache benefit (S3 ETag cache — subsequent loads):")
    from backend.main import load_jsonl_from_file, _clear_file_cache, _file_cache
    import backend.main as main_module

    original = main_module.PROJECT_ROOT
    main_module.PROJECT_ROOT = file_path.parent.resolve()
    try:
        _clear_file_cache()

        start = time.perf_counter()
        load_jsonl_from_file(str(file_path))
        cold = time.perf_counter() - start

        start = time.perf_counter()
        load_jsonl_from_file(str(file_path))
        warm = time.perf_counter() - start

        # Serialize cached data (still needed on warm load)
        cached_data = _file_cache[str(file_path.resolve())][1]
        start = time.perf_counter()
        orjson.dumps({"samples": cached_data, "total": len(cached_data)})
        t_ser_cached = time.perf_counter() - start

        print(f"  Cold load (parse):     {cold:.3f}s")
        print(f"  Warm load (cached):    {warm * 1000:.3f}ms")
        print(f"  + serialize (orjson):  {t_ser_cached:.3f}s")
        print(f"  Warm total:            {warm + t_ser_cached:.3f}s")
        print(f"  Cold → Warm speedup:   {(cold + t_ser_cached) / (warm + t_ser_cached):.1f}x")
    finally:
        main_module.PROJECT_ROOT = original


def main():
    print("=" * 65)
    print("  S3 Loading Speed Benchmark — 100 MB File")
    print("=" * 65)
    print()

    with tempfile.TemporaryDirectory() as tmpdir:
        large_file = Path(tmpdir) / "benchmark_100mb.jsonl"
        generate_100mb_jsonl(large_file)
        run_benchmark(large_file)

    print()
    print("=" * 65)


if __name__ == "__main__":
    main()
