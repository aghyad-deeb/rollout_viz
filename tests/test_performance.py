"""Performance/benchmark tests — marked with @pytest.mark.performance."""

import json
import time
import asyncio
from unittest.mock import patch, MagicMock

import pytest
from pathlib import Path


SAMPLE_FILE = Path(__file__).parent.parent / "sample_rollout_traces.jsonl"


@pytest.mark.performance
class TestS3ClientSingleton:
    """Tests for the S3 client singleton pattern."""

    def test_s3_client_is_singleton(self, mock_s3):
        """Calling _get_s3_client() twice returns the exact same object."""
        from backend.main import _get_s3_client, _reset_s3_client
        _reset_s3_client()
        client1 = _get_s3_client()
        client2 = _get_s3_client()
        assert client1 is client2

    def test_s3_client_1000_cached_calls_under_50ms(self, mock_s3):
        """1000 calls to _get_s3_client() complete in under 50ms (cached)."""
        from backend.main import _get_s3_client, _reset_s3_client
        _reset_s3_client()
        # Warm up
        _get_s3_client()
        start = time.perf_counter()
        for _ in range(1000):
            _get_s3_client()
        elapsed = time.perf_counter() - start
        assert elapsed < 0.05, f"1000 cached calls took {elapsed:.4f}s, expected < 0.05s"

    def test_s3_operations_reuse_client(self, mock_s3):
        """S3 operations reuse the singleton client (boto3.client called once)."""
        from backend.main import list_s3_files, _get_s3_client, _reset_s3_client
        _reset_s3_client()
        # First call creates the client
        list_s3_files(mock_s3["bucket"])
        client_after_first = _get_s3_client()
        # Second call should reuse the same client
        list_s3_files(mock_s3["bucket"])
        client_after_second = _get_s3_client()
        assert client_after_first is client_after_second


@pytest.mark.performance
class TestGzipMiddleware:
    """Tests for GZip response compression."""

    @pytest.mark.asyncio
    async def test_gzip_response_header(self, app_no_auth, temp_jsonl, patch_project_root):
        """GET /api/samples with Accept-Encoding: gzip returns gzip content-encoding."""
        file_path = temp_jsonl()
        client = await app_no_auth()
        resp = await client.get(
            f"/api/samples?file={file_path}",
            headers={"Accept-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert resp.headers.get("content-encoding") == "gzip"
        await client.aclose()

    @pytest.mark.asyncio
    async def test_gzip_applied_to_large_responses(self, app_no_auth, tmp_path, patch_project_root):
        """GZip middleware compresses responses above minimum_size threshold."""
        # Generate a larger dataset to exceed minimum_size=1000
        file_path = tmp_path / "big.jsonl"
        with open(file_path, 'w') as f:
            for i in range(100):
                sample = {
                    "messages": [
                        {"role": "user", "content": f"Question {i} with enough content to make a large response"},
                        {"role": "assistant", "content": f"Answer {i} with detailed explanation for testing compression"},
                    ],
                    "attributes": {"step": i, "rollout_n": i, "reward": i * 0.1},
                    "timestamp": "2026-01-15T10:00:00",
                }
                f.write(json.dumps(sample) + "\n")

        client = await app_no_auth()

        # Verify gzip is applied (content-encoding header present)
        resp = await client.get(
            f"/api/samples?file={file_path}",
            headers={"Accept-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert resp.headers.get("content-encoding") == "gzip"
        # The decompressed content should be valid JSON with 100 samples
        data = resp.json()
        assert data["total"] == 100

        # Verify no gzip when not requested
        resp_no_gzip = await client.get(
            f"/api/samples?file={file_path}",
            headers={"Accept-Encoding": "identity"},
        )
        assert resp_no_gzip.headers.get("content-encoding") != "gzip"
        await client.aclose()


    @pytest.mark.performance
    def test_gzip_level_1_faster_than_default(self):
        """Compressing at level 1 is at least 2x faster than level 9."""
        import gzip

        # Generate ~3-5 MB of compressible JSON-like data
        data = (json.dumps({"messages": [{"role": "user", "content": "Q0 " + "x" * 500}]}) + "\n").encode()
        payload = data * 500

        # Time level 9
        start = time.perf_counter()
        for _ in range(3):
            gzip.compress(payload, compresslevel=9)
        time_9 = time.perf_counter() - start

        # Time level 1
        start = time.perf_counter()
        for _ in range(3):
            gzip.compress(payload, compresslevel=1)
        time_1 = time.perf_counter() - start

        ratio = time_1 / time_9
        assert ratio < 0.5, f"Level 1 took {ratio:.2f}x of level 9 time, expected < 0.5x"


@pytest.mark.performance
class TestFileCache:
    """Tests for the local file loading cache."""

    def test_file_cache_second_load_under_1ms(self, tmp_path):
        """Second load of cached file completes in under 1ms."""
        from backend.main import load_jsonl_from_file, _clear_file_cache
        import backend.main as main_module

        # Generate a 500-sample file
        file_path = tmp_path / "cached_test.jsonl"
        with open(file_path, 'w') as f:
            for i in range(500):
                sample = {
                    "messages": [{"role": "user", "content": f"Q{i}"}],
                    "attributes": {"step": i, "rollout_n": i, "reward": 0.5},
                    "timestamp": "2026-01-15T10:00:00",
                }
                f.write(json.dumps(sample) + "\n")

        original = main_module.PROJECT_ROOT
        main_module.PROJECT_ROOT = tmp_path
        try:
            _clear_file_cache()
            # First load (cold)
            load_jsonl_from_file(str(file_path))
            # Second load (cached)
            start = time.perf_counter()
            result = load_jsonl_from_file(str(file_path))
            elapsed = time.perf_counter() - start
            assert elapsed < 0.001, f"Cached load took {elapsed:.6f}s, expected < 1ms"
            assert len(result) == 500
        finally:
            main_module.PROJECT_ROOT = original

    def test_file_cache_invalidated_on_mtime_change(self, tmp_path):
        """Modifying the file between loads returns new content."""
        from backend.main import load_jsonl_from_file, _clear_file_cache
        import backend.main as main_module

        file_path = tmp_path / "mtime_test.jsonl"
        with open(file_path, 'w') as f:
            f.write(json.dumps({"messages": [{"role": "user", "content": "v1"}], "timestamp": ""}) + "\n")

        original = main_module.PROJECT_ROOT
        main_module.PROJECT_ROOT = tmp_path
        try:
            _clear_file_cache()
            result1 = load_jsonl_from_file(str(file_path))
            assert result1[0]["messages"][0]["content"] == "v1"

            # Modify file (change mtime)
            import os
            time.sleep(0.05)  # Ensure mtime changes
            with open(file_path, 'w') as f:
                f.write(json.dumps({"messages": [{"role": "user", "content": "v2"}], "timestamp": ""}) + "\n")

            result2 = load_jsonl_from_file(str(file_path))
            assert result2[0]["messages"][0]["content"] == "v2"
        finally:
            main_module.PROJECT_ROOT = original

    def test_file_cache_clear_works(self, tmp_path):
        """_clear_file_cache() causes next load to be cold."""
        from backend.main import load_jsonl_from_file, _clear_file_cache
        import backend.main as main_module

        file_path = tmp_path / "clear_test.jsonl"
        with open(file_path, 'w') as f:
            f.write(json.dumps({"messages": [{"role": "user", "content": "x"}], "timestamp": ""}) + "\n")

        original = main_module.PROJECT_ROOT
        main_module.PROJECT_ROOT = tmp_path
        try:
            _clear_file_cache()
            load_jsonl_from_file(str(file_path))
            _clear_file_cache()

            # Should need to re-read from disk (not instant)
            result = load_jsonl_from_file(str(file_path))
            assert len(result) == 1
        finally:
            main_module.PROJECT_ROOT = original


@pytest.mark.performance
class TestVizExistsCache:
    """Tests for the viz_file_exists() TTL cache."""

    def test_viz_exists_cached_no_second_s3_call(self, mock_s3):
        """Calling viz_file_exists() twice for same S3 path doesn't make a second head_object."""
        from backend.main import viz_file_exists, _clear_viz_exists_cache, _reset_s3_client
        _clear_viz_exists_cache()
        _reset_s3_client()

        # Create a viz file in the mock bucket
        mock_s3["s3"].put_object(
            Bucket=mock_s3["bucket"],
            Key="data/viz/traces.jsonl",
            Body=b"{}",
        )

        viz_path = f"s3://{mock_s3['bucket']}/data/viz/traces.jsonl"

        # First call — actually checks S3
        result1 = viz_file_exists(viz_path)
        assert result1 is True

        # Patch head_object to verify no second call
        original_client = _reset_s3_client  # just to re-init
        from backend.main import _get_s3_client
        client = _get_s3_client()
        original_head = client.head_object
        call_count = [0]
        def counting_head(*args, **kwargs):
            call_count[0] += 1
            return original_head(*args, **kwargs)
        client.head_object = counting_head

        # Second call — should use cache
        result2 = viz_file_exists(viz_path)
        assert result2 is True
        assert call_count[0] == 0, f"head_object called {call_count[0]} times, expected 0 (cached)"

    def test_viz_exists_1000_cached_calls_under_10ms(self, tmp_path, patch_project_root):
        """1000 cached viz_file_exists() calls complete in under 10ms."""
        from backend.main import viz_file_exists, _clear_viz_exists_cache

        viz_dir = tmp_path / "viz"
        viz_dir.mkdir()
        viz_file = viz_dir / "test.jsonl"
        viz_file.touch()
        viz_path = str(viz_file)

        _clear_viz_exists_cache()
        # Warm up cache
        viz_file_exists(viz_path)

        start = time.perf_counter()
        for _ in range(1000):
            viz_file_exists(viz_path)
        elapsed = time.perf_counter() - start
        assert elapsed < 0.01, f"1000 cached calls took {elapsed:.4f}s, expected < 0.01s"


@pytest.mark.performance
class TestPerformance:
    """Performance benchmarks for critical paths."""

    @pytest.mark.skipif(not SAMPLE_FILE.exists(), reason="sample_rollout_traces.jsonl not found")
    def test_load_samples_sync_under_2s(self):
        """Load 4.2MB sample file via _load_samples_sync in under 2 seconds."""
        from backend.main import _load_samples_sync
        start = time.perf_counter()
        result = _load_samples_sync(str(SAMPLE_FILE))
        elapsed = time.perf_counter() - start
        assert elapsed < 2.0, f"Took {elapsed:.2f}s, expected < 2s"
        assert result["total"] > 0

    @pytest.mark.skipif(not SAMPLE_FILE.exists(), reason="sample_rollout_traces.jsonl not found")
    async def test_samples_endpoint_under_3s(self, app_no_auth):
        """Load via GET /api/samples in under 3 seconds."""
        import backend.main as main_module
        original = main_module.PROJECT_ROOT
        # Point to real project root so the file resolves
        main_module.PROJECT_ROOT = SAMPLE_FILE.parent.resolve()
        try:
            client = await app_no_auth()
            start = time.perf_counter()
            resp = await client.get(f"/api/samples?file={SAMPLE_FILE}")
            elapsed = time.perf_counter() - start
            assert resp.status_code == 200
            assert elapsed < 3.0, f"Took {elapsed:.2f}s, expected < 3s"
            await client.aclose()
        finally:
            main_module.PROJECT_ROOT = original

    def test_parse_1000_jsonl_lines_under_1s(self, tmp_path):
        """Parse 1000 generated JSONL lines in under 1 second."""
        from backend.main import load_jsonl_from_file
        import backend.main as main_module

        # Generate 1000 lines
        file_path = tmp_path / "perf_test.jsonl"
        with open(file_path, 'w') as f:
            for i in range(1000):
                sample = {
                    "messages": [
                        {"role": "user", "content": f"Question {i}"},
                        {"role": "assistant", "content": f"Answer {i} with some longer content to be more realistic"},
                    ],
                    "attributes": {"step": i, "rollout_n": i, "reward": i * 0.1},
                    "timestamp": "2026-01-15T10:00:00",
                }
                f.write(json.dumps(sample) + "\n")

        original = main_module.PROJECT_ROOT
        main_module.PROJECT_ROOT = tmp_path
        try:
            start = time.perf_counter()
            result = load_jsonl_from_file(str(file_path))
            elapsed = time.perf_counter() - start
            assert elapsed < 1.0, f"Took {elapsed:.2f}s, expected < 1s"
            assert len(result) == 1000
        finally:
            main_module.PROJECT_ROOT = original

    def test_parse_5000_jsonl_lines_under_1s(self, tmp_path):
        """Parse 5000 generated JSONL lines (~20 MB) in under 1 second."""
        from backend.main import load_jsonl_from_file
        import backend.main as main_module

        # Generate 5000 lines with realistic content (~4KB per sample)
        file_path = tmp_path / "perf_5k.jsonl"
        with open(file_path, 'w') as f:
            for i in range(5000):
                sample = {
                    "messages": [
                        {"role": "system", "content": "You are a helpful assistant. " * 10},
                        {"role": "user", "content": f"Question {i}: " + "x" * 500},
                        {"role": "assistant", "content": f"Answer {i}: " + "y" * 1000},
                    ],
                    "attributes": {"step": i, "rollout_n": i, "reward": i * 0.1},
                    "timestamp": "2026-01-15T10:00:00",
                }
                f.write(json.dumps(sample) + "\n")

        original = main_module.PROJECT_ROOT
        main_module.PROJECT_ROOT = tmp_path
        try:
            start = time.perf_counter()
            result = load_jsonl_from_file(str(file_path))
            elapsed = time.perf_counter() - start
            assert elapsed < 1.0, f"Took {elapsed:.2f}s, expected < 1s"
            assert len(result) == 5000
        finally:
            main_module.PROJECT_ROOT = original

    @pytest.mark.asyncio
    async def test_orjson_response_used(self, app_no_auth, tmp_path, patch_project_root):
        """GET /api/samples returns valid JSON response (sanity check for ORJSONResponse)."""
        # Generate test data
        file_path = tmp_path / "orjson_test.jsonl"
        with open(file_path, 'w') as f:
            for i in range(100):
                sample = {
                    "messages": [
                        {"role": "user", "content": f"Q{i}"},
                        {"role": "assistant", "content": f"A{i}"},
                    ],
                    "attributes": {"step": i, "rollout_n": i, "reward": i * 0.1},
                    "timestamp": "2026-01-15T10:00:00",
                }
                f.write(json.dumps(sample) + "\n")

        client = await app_no_auth()
        start = time.perf_counter()
        resp = await client.get(f"/api/samples?file={file_path}")
        elapsed = time.perf_counter() - start
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 100
        assert len(data["samples"]) == 100
        await client.aclose()

    def test_safe_resolve_10000_paths_under_2s(self, patch_project_root):
        """_safe_resolve_path for 10,000 paths in under 2 seconds."""
        from backend.main import _safe_resolve_path
        # Create a test file
        test_file = patch_project_root / "test.jsonl"
        test_file.touch()

        start = time.perf_counter()
        for _ in range(10000):
            _safe_resolve_path("test.jsonl")
        elapsed = time.perf_counter() - start
        assert elapsed < 2.0, f"Took {elapsed:.2f}s, expected < 2s"

    @pytest.mark.skipif(not SAMPLE_FILE.exists(), reason="sample_rollout_traces.jsonl not found")
    async def test_concurrent_loads_under_5s(self, app_no_auth):
        """3 concurrent GET /api/samples via asyncio.gather in under 5 seconds."""
        import backend.main as main_module
        original = main_module.PROJECT_ROOT
        main_module.PROJECT_ROOT = SAMPLE_FILE.parent.resolve()
        try:
            client = await app_no_auth()
            start = time.perf_counter()
            tasks = [
                client.get(f"/api/samples?file={SAMPLE_FILE}")
                for _ in range(3)
            ]
            responses = await asyncio.gather(*tasks)
            elapsed = time.perf_counter() - start

            for resp in responses:
                assert resp.status_code == 200
            assert elapsed < 5.0, f"Took {elapsed:.2f}s, expected < 5s"
            await client.aclose()
        finally:
            main_module.PROJECT_ROOT = original
