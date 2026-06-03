"""
Startup and load stress tests for the Rollout Visualizer backend.

Tests with:
  - 5,000 samples per file, each file ~8MB
  - Hundreds of concurrent connections
  - Sustained load for 10+ seconds
  - Memory and file descriptor leak detection
"""

import asyncio
import gc
import json
import os
import time
import tracemalloc

import pytest


# ---------------------------------------------------------------------------
# Sample generators
# ---------------------------------------------------------------------------

def _generate_sample(index: int, content_size: str = "medium") -> dict:
    """Generate a single JSONL sample.

    content_size controls message length:
      - "small": ~200 bytes per sample (minimal messages)
      - "medium": ~1.6KB per sample (5000 samples ≈ 8MB)
      - "large": ~8KB per sample (rich multi-turn conversation)
    """
    if content_size == "small":
        return {
            "messages": [
                {"role": "user", "content": f"Q{index}"},
                {"role": "assistant", "content": f"A{index}"},
            ],
            "attributes": {
                "step": index % 50,
                "sample_index": index,
                "rollout_n": index,
                "reward": round((index % 200 - 100) / 100.0, 2),
                "data_source": f"src_{index % 5}",
                "experiment_name": f"exp_{index % 3}",
                "validate": index % 4 == 0,
            },
            "timestamp": f"2026-01-{15 + (index % 15):02d}T10:{index % 60:02d}:00",
        }

    if content_size == "medium":
        # ~1.6KB per sample → 5000 samples ≈ 8MB
        body = (
            f"Sample {index}: This is a moderately detailed response that covers "
            f"the key aspects of the question. The analysis involves several steps. "
            f"First, we consider the primary factors at play. Then we examine "
            f"secondary considerations. The conclusion draws from both quantitative "
            f"and qualitative evidence gathered during the investigation. "
            f"Additional context includes batch {index // 100} and source {index % 10}. "
        )
        reasoning = (
            f"<think>Let me analyze this step by step for question {index}. "
            f"The core issue here involves understanding the interaction between "
            f"multiple variables in a complex system. I need to consider precedent, "
            f"feasibility, and downstream effects before formulating my answer.</think>"
        )
        return {
            "messages": [
                {"role": "system", "content": "You are an expert analyst. Think carefully."},
                {"role": "user", "content": (
                    f"Question {index}: Analyze the trade-offs between approach A and "
                    f"approach B for scenario {index % 20}. Consider scalability, "
                    f"maintainability, and performance implications."
                )},
                {"role": "assistant", "content": f"{reasoning}\n\n{body}"},
                {"role": "user", "content": f"Follow-up {index}: What about edge case {index % 7}?"},
                {"role": "assistant", "content": body},
            ],
            "attributes": {
                "step": index % 100,
                "sample_index": index,
                "rollout_n": index,
                "reward": round((index % 200 - 100) / 100.0, 2),
                "data_source": f"stress_test/source_{index % 10}",
                "experiment_name": f"stress_exp_{index % 3}",
                "validate": index % 4 == 0,
                "custom_field": f"val_{index}",
                "tags": ["stress", f"batch_{index // 100}"],
            },
            "timestamp": f"2026-01-{15 + (index % 15):02d}T{10 + (index % 14):02d}:{index % 60:02d}:00",
        }

    # "large" — ~8KB per sample
    block = (
        "This is a detailed paragraph of analysis that covers theoretical foundations, "
        "practical applications, edge cases, and implementation considerations. "
        "The approach needs to account for scalability, fault tolerance, consistency, "
        "and latency requirements in a distributed environment. We must also consider "
        "the operational complexity of each solution and how it integrates with "
        "existing infrastructure and monitoring systems. "
    ) * 4  # ~700 chars

    return {
        "messages": [
            {"role": "system", "content": "You are an expert. Provide thorough analysis."},
            {"role": "user", "content": f"Detailed question {index} about complex topic {index % 50}."},
            {"role": "assistant", "content": f"<think>{block}</think>\n\n{block}"},
            {"role": "user", "content": f"Follow-up {index}: elaborate on point {index % 7}."},
            {"role": "assistant", "content": f"<reasoning>{block}</reasoning>\n\n{block}"},
            {"role": "user", "content": f"Final question {index}: summarize key takeaways."},
            {"role": "assistant", "content": block},
        ],
        "attributes": {
            "step": index % 100,
            "sample_index": index,
            "rollout_n": index,
            "reward": round((index % 200 - 100) / 100.0, 2),
            "data_source": f"stress_test/source_{index % 10}",
            "experiment_name": f"stress_exp_{index % 3}",
            "validate": index % 4 == 0,
        },
        "timestamp": f"2026-01-{15 + (index % 15):02d}T{10 + (index % 14):02d}:{index % 60:02d}:00",
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def stress_jsonl(tmp_path, patch_project_root):
    """Factory that creates stress-test JSONL files.

    Returns (file_path, sample_count, file_size_bytes).
    """
    def _create(
        num_samples: int = 5000,
        content_size: str = "medium",
        filename: str = "stress_test.jsonl",
    ):
        file_path = patch_project_root / filename
        with open(file_path, "w") as f:
            for i in range(num_samples):
                f.write(json.dumps(_generate_sample(i, content_size)) + "\n")
        actual_size = os.path.getsize(file_path)
        return file_path, num_samples, actual_size

    return _create


# ---------------------------------------------------------------------------
# Basic startup flow (kept as regression)
# ---------------------------------------------------------------------------

class TestStartupFlow:
    """Simulates the browser startup sequence."""

    async def test_auth_check_responds_quickly(self, app_no_auth):
        client = await app_no_auth()
        start = time.perf_counter()
        response = await client.get("/api/auth/check")
        elapsed = time.perf_counter() - start
        assert response.status_code == 200
        assert elapsed < 0.2
        await client.aclose()

    async def test_health_check_responds_quickly(self, app_no_auth):
        client = await app_no_auth()
        start = time.perf_counter()
        response = await client.get("/api/health")
        elapsed = time.perf_counter() - start
        assert response.status_code == 200
        assert elapsed < 0.1
        await client.aclose()

    async def test_full_startup_sequence(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        temp_jsonl(sample_data, "startup_test.jsonl")
        client = await app_no_auth()
        file_path = patch_project_root / "startup_test.jsonl"

        start = time.perf_counter()
        auth = await client.get("/api/auth/check")
        assert auth.status_code == 200
        samples = await client.get(f"/api/samples?file={file_path}")
        assert samples.status_code == 200
        elapsed = time.perf_counter() - start
        assert elapsed < 2.0
        await client.aclose()

    async def test_missing_file_returns_error_fast(self, app_no_auth, patch_project_root):
        client = await app_no_auth()
        start = time.perf_counter()
        response = await client.get("/api/samples?file=nonexistent.jsonl")
        elapsed = time.perf_counter() - start
        assert response.status_code == 404
        assert elapsed < 0.5
        await client.aclose()


# ---------------------------------------------------------------------------
# 5,000-sample / 8MB file stress tests
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestLargeFileLoading:
    """Load tests with 5,000 samples (~8MB per file)."""

    async def test_load_5000_samples(self, app_no_auth, stress_jsonl):
        """Load a file with 5,000 samples. Should complete within 5 seconds."""
        file_path, count, size_bytes = stress_jsonl(5000, "medium", "5k_test.jsonl")
        size_mb = size_bytes / (1024 * 1024)
        client = await app_no_auth()

        start = time.perf_counter()
        response = await client.get(f"/api/samples?file={file_path}")
        elapsed = time.perf_counter() - start

        assert response.status_code == 200
        data = response.json()
        assert len(data["samples"]) == 5000
        assert elapsed < 5.0, f"Loading {size_mb:.1f}MB ({count} samples) took {elapsed:.2f}s"
        print(f"\n  5,000 samples ({size_mb:.1f}MB): {elapsed:.2f}s")
        await client.aclose()

    async def test_load_8mb_file_with_rich_samples(self, app_no_auth, stress_jsonl):
        """Load an 8MB file with larger per-sample content."""
        file_path, count, size_bytes = stress_jsonl(1000, "large", "8mb_rich.jsonl")
        size_mb = size_bytes / (1024 * 1024)
        client = await app_no_auth()

        start = time.perf_counter()
        response = await client.get(f"/api/samples?file={file_path}")
        elapsed = time.perf_counter() - start

        assert response.status_code == 200
        assert len(response.json()["samples"]) == count
        assert elapsed < 5.0
        print(f"\n  {count} rich samples ({size_mb:.1f}MB): {elapsed:.2f}s")
        await client.aclose()

    async def test_response_data_integrity_5000(self, app_no_auth, stress_jsonl):
        """Verify all 5,000 samples are returned correctly with proper attributes."""
        file_path, count, _ = stress_jsonl(5000, "medium", "integrity_test.jsonl")
        client = await app_no_auth()

        response = await client.get(f"/api/samples?file={file_path}")
        assert response.status_code == 200
        data = response.json()

        samples = data["samples"]
        assert len(samples) == 5000
        assert data["total"] == 5000

        # Verify sequential IDs
        ids = [s["id"] for s in samples]
        assert ids == list(range(5000))

        # Verify attribute processing (validate → is_validate rename)
        for s in samples:
            assert "is_validate" in s["attributes"]
            assert "validate" not in s["attributes"]

        # Verify first and last samples have correct data
        assert samples[0]["attributes"]["sample_index"] == 0
        assert samples[4999]["attributes"]["sample_index"] == 4999

        # Verify messages are preserved
        for s in samples[:10]:
            assert len(s["messages"]) >= 2
            assert s["messages"][0]["role"] in ("system", "user")
        await client.aclose()

    async def test_sequential_5000_sample_loads(self, app_no_auth, stress_jsonl):
        """Load the same 5,000-sample file 5 times sequentially.

        Checks that later loads aren't slower (no accumulation).
        """
        file_path, count, _ = stress_jsonl(5000, "medium", "seq_test.jsonl")
        client = await app_no_auth()
        timings = []

        for i in range(5):
            start = time.perf_counter()
            response = await client.get(f"/api/samples?file={file_path}")
            elapsed = time.perf_counter() - start
            assert response.status_code == 200
            assert len(response.json()["samples"]) == 5000
            timings.append(elapsed)

        # No load should be >2x the first (no degradation)
        for i, t in enumerate(timings):
            assert t < timings[0] * 2.5, (
                f"Load {i+1} ({t:.2f}s) is {t/timings[0]:.1f}x slower than load 1 ({timings[0]:.2f}s)"
            )
        print(f"\n  5x sequential 5K loads: {[f'{t:.2f}s' for t in timings]}")
        await client.aclose()


# ---------------------------------------------------------------------------
# High concurrency with large files
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestHighConcurrency:
    """Concurrent access patterns with 5,000-sample files."""

    async def test_10_concurrent_5000_sample_loads(self, app_no_auth, stress_jsonl):
        """10 clients loading 5,000 samples simultaneously."""
        file_path, count, size_bytes = stress_jsonl(5000, "medium", "conc10_test.jsonl")
        size_mb = size_bytes / (1024 * 1024)
        client = await app_no_auth()

        start = time.perf_counter()
        tasks = [
            asyncio.create_task(client.get(f"/api/samples?file={file_path}"))
            for _ in range(10)
        ]
        responses = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - start

        for r in responses:
            assert r.status_code == 200
            assert len(r.json()["samples"]) == 5000
        assert elapsed < 15.0, f"10 concurrent 5K loads took {elapsed:.2f}s"
        print(f"\n  10x concurrent 5K ({size_mb:.1f}MB): {elapsed:.2f}s ({10/elapsed:.1f} req/s)")
        await client.aclose()

    async def test_50_concurrent_5000_sample_loads(self, app_no_auth, stress_jsonl):
        """50 clients loading 5,000 samples simultaneously — thread pool crusher."""
        file_path, count, size_bytes = stress_jsonl(5000, "medium", "conc50_test.jsonl")
        size_mb = size_bytes / (1024 * 1024)
        client = await app_no_auth()

        start = time.perf_counter()
        tasks = [
            asyncio.create_task(client.get(f"/api/samples?file={file_path}"))
            for _ in range(50)
        ]
        responses = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - start

        success = sum(1 for r in responses if r.status_code == 200)
        assert success == 50, f"Only {success}/50 succeeded"
        for r in responses:
            assert len(r.json()["samples"]) == 5000
        assert elapsed < 60.0, f"50 concurrent 5K loads took {elapsed:.2f}s"
        print(f"\n  50x concurrent 5K ({size_mb:.1f}MB): {elapsed:.2f}s ({50/elapsed:.1f} req/s)")
        await client.aclose()

    async def test_200_concurrent_auth_checks(self, app_no_auth):
        """200 concurrent auth checks."""
        client = await app_no_auth()
        start = time.perf_counter()
        tasks = [asyncio.create_task(client.get("/api/auth/check")) for _ in range(200)]
        responses = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - start

        assert all(r.status_code == 200 for r in responses)
        assert elapsed < 5.0
        print(f"\n  200 concurrent auth checks: {elapsed:.2f}s ({200/elapsed:.0f} req/s)")
        await client.aclose()

    async def test_mixed_load_with_large_files(self, app_no_auth, stress_jsonl):
        """Mix of 200 health + 100 auth + 20 large-file loads simultaneously.

        Tests that lightweight requests aren't starved by heavy file loads.
        """
        file_path, _, _ = stress_jsonl(5000, "medium", "mixed_test.jsonl")
        client = await app_no_auth()

        start = time.perf_counter()
        tasks = []
        tasks.extend(asyncio.create_task(client.get("/api/health")) for _ in range(200))
        tasks.extend(asyncio.create_task(client.get("/api/auth/check")) for _ in range(100))
        tasks.extend(
            asyncio.create_task(client.get(f"/api/samples?file={file_path}"))
            for _ in range(20)
        )
        responses = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - start

        success = sum(1 for r in responses if r.status_code == 200)
        assert success == 320, f"Only {success}/320 succeeded"
        assert elapsed < 30.0
        print(f"\n  Mixed (200+100+20x5K): {elapsed:.2f}s ({320/elapsed:.0f} req/s)")
        await client.aclose()

    async def test_concurrent_different_large_files(self, app_no_auth, stress_jsonl):
        """10 clients each loading a DIFFERENT 5,000-sample file simultaneously.

        Tests that the thread pool and I/O handle diverse file access.
        """
        paths = []
        for i in range(10):
            fp, _, _ = stress_jsonl(5000, "medium", f"diff_{i}.jsonl")
            paths.append(fp)

        client = await app_no_auth()
        start = time.perf_counter()
        tasks = [
            asyncio.create_task(client.get(f"/api/samples?file={path}"))
            for path in paths
        ]
        responses = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - start

        for r in responses:
            assert r.status_code == 200
            assert len(r.json()["samples"]) == 5000
        assert elapsed < 20.0
        print(f"\n  10x different 5K files concurrently: {elapsed:.2f}s")
        await client.aclose()


# ---------------------------------------------------------------------------
# Sustained load
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestSustainedLoad:
    """Sustained traffic for 10+ seconds with large files."""

    async def test_sustained_5000_sample_loads_15s(self, app_no_auth, stress_jsonl):
        """Fire 5,000-sample loads continuously for 15 seconds.

        Measures throughput stability and catches degradation.
        """
        file_path, _, size_bytes = stress_jsonl(5000, "medium", "sustained_5k.jsonl")
        size_mb = size_bytes / (1024 * 1024)
        client = await app_no_auth()

        duration = 15.0
        request_count = 0
        errors = 0
        latencies = []
        start = time.perf_counter()

        while time.perf_counter() - start < duration:
            batch_start = time.perf_counter()
            # 3 concurrent 5K loads per batch
            tasks = [
                asyncio.create_task(client.get(f"/api/samples?file={file_path}"))
                for _ in range(3)
            ]
            responses = await asyncio.gather(*tasks, return_exceptions=True)
            batch_elapsed = time.perf_counter() - batch_start
            latencies.append(batch_elapsed)

            for r in responses:
                if isinstance(r, Exception):
                    errors += 1
                elif r.status_code == 200:
                    request_count += 1
                else:
                    errors += 1

        total = time.perf_counter() - start
        assert errors == 0, f"{errors} failed during sustained 5K load"
        assert request_count > 10, f"Only {request_count} completed in {duration}s"

        # Check for degradation
        quarter = max(1, len(latencies) // 4)
        avg_first = sum(latencies[:quarter]) / quarter
        avg_last = sum(latencies[-quarter:]) / quarter
        ratio = avg_last / avg_first if avg_first > 0 else 1.0
        assert ratio < 3.0, (
            f"Latency degraded {ratio:.1f}x (first: {avg_first*1000:.0f}ms → last: {avg_last*1000:.0f}ms)"
        )
        print(
            f"\n  Sustained 5K load ({size_mb:.1f}MB): {request_count} loads in {total:.1f}s "
            f"({request_count/total:.1f} req/s, {request_count*size_mb/total:.1f} MB/s), "
            f"degradation ratio: {ratio:.2f}x"
        )
        await client.aclose()

    async def test_sustained_auth_with_background_file_loads(self, app_no_auth, stress_jsonl):
        """Auth checks continue responding fast while large files are loading.

        Simulates: backend is serving a heavy file load, user opens a new tab.
        """
        file_path, _, _ = stress_jsonl(5000, "medium", "bg_load.jsonl")
        client = await app_no_auth()

        auth_latencies = []
        errors = 0
        duration = 10.0
        start = time.perf_counter()

        # Start a continuous stream of heavy file loads in background
        async def background_load():
            while time.perf_counter() - start < duration:
                try:
                    await client.get(f"/api/samples?file={file_path}")
                except Exception:
                    pass

        bg_tasks = [asyncio.create_task(background_load()) for _ in range(5)]

        # Meanwhile, measure auth check latency
        while time.perf_counter() - start < duration:
            auth_start = time.perf_counter()
            try:
                r = await client.get("/api/auth/check")
                auth_elapsed = time.perf_counter() - auth_start
                if r.status_code == 200:
                    auth_latencies.append(auth_elapsed)
                else:
                    errors += 1
            except Exception:
                errors += 1
            await asyncio.sleep(0.05)  # ~20 auth checks/s

        # Cancel background tasks
        for t in bg_tasks:
            t.cancel()
        await asyncio.gather(*bg_tasks, return_exceptions=True)

        total = time.perf_counter() - start
        assert errors == 0, f"{errors} auth check errors during background load"
        assert len(auth_latencies) > 50

        avg_auth = sum(auth_latencies) / len(auth_latencies)
        max_auth = max(auth_latencies)
        p99_idx = int(len(auth_latencies) * 0.99)
        sorted_latencies = sorted(auth_latencies)
        p99 = sorted_latencies[p99_idx] if p99_idx < len(sorted_latencies) else max_auth

        assert avg_auth < 0.5, f"Avg auth latency {avg_auth*1000:.0f}ms under load (should be < 500ms)"
        assert p99 < 2.0, f"P99 auth latency {p99*1000:.0f}ms (should be < 2000ms)"
        print(
            f"\n  Auth under 5K load: {len(auth_latencies)} checks, "
            f"avg={avg_auth*1000:.0f}ms, p99={p99*1000:.0f}ms, max={max_auth*1000:.0f}ms"
        )
        await client.aclose()


# ---------------------------------------------------------------------------
# Memory and resource leak detection
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestResourcePressure:
    """Detect memory leaks and file descriptor leaks under stress."""

    async def test_memory_stable_after_repeated_5k_loads(self, app_no_auth, stress_jsonl):
        """Load a 5,000-sample file 20 times, verify memory doesn't grow unboundedly."""
        file_path, _, size_bytes = stress_jsonl(5000, "medium", "mem_test.jsonl")
        size_mb = size_bytes / (1024 * 1024)
        client = await app_no_auth()

        gc.collect()
        tracemalloc.start()
        snapshot_before = tracemalloc.take_snapshot()

        for _ in range(20):
            response = await client.get(f"/api/samples?file={file_path}")
            assert response.status_code == 200
            assert len(response.json()["samples"]) == 5000

        gc.collect()
        snapshot_after = tracemalloc.take_snapshot()
        tracemalloc.stop()

        stats = snapshot_after.compare_to(snapshot_before, "lineno")
        total_growth = sum(s.size_diff for s in stats if s.size_diff > 0)
        total_growth_mb = total_growth / (1024 * 1024)

        # 20 loads of ~8MB = 160MB processed. Growth should be << 160MB.
        assert total_growth_mb < 80.0, (
            f"Memory grew {total_growth_mb:.1f}MB after 20x {size_mb:.1f}MB loads — likely a leak"
        )
        print(f"\n  Memory growth after 20x 5K loads: {total_growth_mb:.1f}MB")
        await client.aclose()

    async def test_file_descriptors_stable_after_5k_loads(self, app_no_auth, stress_jsonl):
        """File descriptors must not leak after repeated large file loads."""
        file_path, _, _ = stress_jsonl(5000, "medium", "fd_test.jsonl")
        client = await app_no_auth()

        pid = os.getpid()
        try:
            fd_before = len(os.listdir(f"/proc/{pid}/fd"))
        except FileNotFoundError:
            pytest.skip("No /proc/PID/fd on this platform")

        for _ in range(30):
            response = await client.get(f"/api/samples?file={file_path}")
            assert response.status_code == 200

        gc.collect()
        fd_after = len(os.listdir(f"/proc/{pid}/fd"))
        fd_growth = fd_after - fd_before

        assert fd_growth < 20, (
            f"FDs grew by {fd_growth} after 30 loads (before={fd_before}, after={fd_after})"
        )
        print(f"\n  FD growth after 30x 5K loads: {fd_growth} ({fd_before} → {fd_after})")
        await client.aclose()

    async def test_concurrent_5k_loads_dont_leak_memory(self, app_no_auth, stress_jsonl):
        """50 concurrent 5K loads should not leave significant memory behind."""
        file_path, _, _ = stress_jsonl(5000, "medium", "conc_mem_test.jsonl")
        client = await app_no_auth()

        gc.collect()
        tracemalloc.start()

        tasks = [
            asyncio.create_task(client.get(f"/api/samples?file={file_path}"))
            for _ in range(50)
        ]
        responses = await asyncio.gather(*tasks)
        for r in responses:
            assert r.status_code == 200

        # Force cleanup. Completed asyncio tasks may keep their result buffers
        # reachable until the loop gets a scheduling turn.
        del responses
        del tasks
        await asyncio.sleep(0)
        gc.collect()

        current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        current_mb = current / (1024 * 1024)
        peak_mb = peak / (1024 * 1024)

        print(f"\n  After 50x concurrent 5K: current={current_mb:.1f}MB, peak={peak_mb:.1f}MB")
        # Peak can be high (50 × 8MB responses in flight), but current should drop
        assert current_mb < peak_mb * 0.8 or current_mb < 50.0, (
            f"Memory not released: current={current_mb:.1f}MB, peak={peak_mb:.1f}MB"
        )
        await client.aclose()


# ---------------------------------------------------------------------------
# Error handling under stress
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestErrorHandlingUnderStress:
    """Verify graceful error handling when things go wrong under load."""

    async def test_interleaved_valid_and_404_at_scale(self, app_no_auth, stress_jsonl):
        """Alternate valid 5K loads and 404s 50 times. Error handling must not corrupt state."""
        file_path, _, _ = stress_jsonl(5000, "medium", "err_test.jsonl")
        client = await app_no_auth()

        for i in range(50):
            r = await client.get(f"/api/samples?file={file_path}")
            assert r.status_code == 200
            assert len(r.json()["samples"]) == 5000

            r = await client.get("/api/samples?file=nonexistent.jsonl")
            assert r.status_code == 404

        # Final valid load must still work perfectly
        r = await client.get(f"/api/samples?file={file_path}")
        assert r.status_code == 200
        assert len(r.json()["samples"]) == 5000
        await client.aclose()

    async def test_concurrent_valid_and_invalid_requests(self, app_no_auth, stress_jsonl):
        """Fire 25 valid and 25 invalid requests simultaneously."""
        file_path, _, _ = stress_jsonl(5000, "medium", "conc_err_test.jsonl")
        client = await app_no_auth()

        tasks = []
        for i in range(50):
            if i % 2 == 0:
                tasks.append(asyncio.create_task(
                    client.get(f"/api/samples?file={file_path}")
                ))
            else:
                tasks.append(asyncio.create_task(
                    client.get("/api/samples?file=bogus.jsonl")
                ))

        responses = await asyncio.gather(*tasks)
        valid_count = sum(1 for r in responses if r.status_code == 200)
        error_count = sum(1 for r in responses if r.status_code == 404)

        assert valid_count == 25, f"Expected 25 valid responses, got {valid_count}"
        assert error_count == 25, f"Expected 25 404s, got {error_count}"
        await client.aclose()
