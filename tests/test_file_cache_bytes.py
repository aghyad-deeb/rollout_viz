"""Byte-budget eviction for the file loading cache.

The cache previously capped only the ENTRY COUNT (20). With files up to
MAX_FILE_SIZE (500MB default), 20 parsed files can exceed available memory.
These tests pin the byte-budget behavior: raw file bytes are tracked per
entry and oldest-inserted entries are evicted until the budget holds.
"""

import json

import pytest


def _write_jsonl(path, n_samples, content_pad=""):
    with open(path, "w") as f:
        for i in range(n_samples):
            sample = {
                "messages": [{"role": "user", "content": f"Q{i}{content_pad}"}],
                "attributes": {"step": 1, "rollout_n": i, "reward": 0.0},
                "timestamp": "2026-01-15T10:00:00",
            }
            f.write(json.dumps(sample) + "\n")
    return path.stat().st_size


class TestFileCacheByteBudget:
    def test_byte_budget_evicts_oldest(self, patch_project_root, monkeypatch):
        """Loading past the byte budget evicts the oldest entry, keeps the newest."""
        import backend.main as main_module
        from backend.main import load_jsonl_from_file, _clear_file_cache

        tmp_path = patch_project_root
        a = tmp_path / "a.jsonl"
        b = tmp_path / "b.jsonl"
        size_a = _write_jsonl(a, 3)
        size_b = _write_jsonl(b, 3)

        # Budget fits one file but not two.
        monkeypatch.setattr(main_module, "_FILE_CACHE_MAX_BYTES", max(size_a, size_b) + 10)
        _clear_file_cache()

        load_jsonl_from_file(str(a))
        load_jsonl_from_file(str(b))

        assert str(b.resolve()) in main_module._file_cache, "newest entry must be kept"
        assert str(a.resolve()) not in main_module._file_cache, (
            "oldest entry must be evicted once the byte budget is exceeded"
        )

    def test_oversized_single_entry_still_cached(self, patch_project_root, monkeypatch):
        """A file bigger than the whole budget is still cached (alone) — evicting
        it would only force an immediate re-read of the same file."""
        import backend.main as main_module
        from backend.main import load_jsonl_from_file, _clear_file_cache

        tmp_path = patch_project_root
        a = tmp_path / "big.jsonl"
        _write_jsonl(a, 5, content_pad="x" * 100)

        monkeypatch.setattr(main_module, "_FILE_CACHE_MAX_BYTES", 10)
        _clear_file_cache()

        first = load_jsonl_from_file(str(a))
        assert len(main_module._file_cache) == 1
        second = load_jsonl_from_file(str(a))
        assert second is first, "warm load must hit the cache (identity)"

    def test_entry_count_cap_still_enforced(self, patch_project_root, monkeypatch):
        """The 20-entry cap survives the byte-budget change."""
        import backend.main as main_module
        from backend.main import load_jsonl_from_file, _clear_file_cache

        tmp_path = patch_project_root
        monkeypatch.setattr(main_module, "_FILE_CACHE_MAX_BYTES", 10**12)
        _clear_file_cache()

        for i in range(main_module._FILE_CACHE_MAX + 5):
            p = tmp_path / f"f{i}.jsonl"
            _write_jsonl(p, 1)
            load_jsonl_from_file(str(p))

        assert len(main_module._file_cache) <= main_module._FILE_CACHE_MAX
        newest = tmp_path / f"f{main_module._FILE_CACHE_MAX + 4}.jsonl"
        assert str(newest.resolve()) in main_module._file_cache

    def test_reload_refreshes_eviction_order(self, patch_project_root, monkeypatch):
        """Re-loading a changed file moves it to the back of the FIFO order, so
        the truly stalest entry is evicted first."""
        import time

        import backend.main as main_module
        from backend.main import load_jsonl_from_file, _clear_file_cache

        tmp_path = patch_project_root
        a = tmp_path / "a.jsonl"
        b = tmp_path / "b.jsonl"
        c = tmp_path / "c.jsonl"
        size = _write_jsonl(a, 3)
        _write_jsonl(b, 3)
        _write_jsonl(c, 3)

        # Budget fits two files but not three.
        monkeypatch.setattr(main_module, "_FILE_CACHE_MAX_BYTES", 2 * size + 10)
        _clear_file_cache()

        load_jsonl_from_file(str(a))
        load_jsonl_from_file(str(b))
        # Touch a so its mtime changes, then re-load: a is now the freshest.
        time.sleep(0.02)
        _write_jsonl(a, 3)
        load_jsonl_from_file(str(a))

        load_jsonl_from_file(str(c))

        assert str(b.resolve()) not in main_module._file_cache, "b is stalest — evicted"
        assert str(a.resolve()) in main_module._file_cache
        assert str(c.resolve()) in main_module._file_cache


class TestS3CacheByteBudget:
    def test_s3_byte_budget_evicts_oldest(self, mock_s3, monkeypatch):
        """S3 loads share the same byte budget."""
        import boto3

        import backend.main as main_module
        from backend.main import load_jsonl_from_s3, _clear_file_cache

        s3 = boto3.client("s3", region_name="us-east-1")
        line = json.dumps({
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {}, "timestamp": "",
        })
        body = (line + "\n").encode()
        s3.put_object(Bucket="test-bucket", Key="bytes/a.jsonl", Body=body)
        s3.put_object(Bucket="test-bucket", Key="bytes/b.jsonl", Body=body)

        monkeypatch.setattr(main_module, "_FILE_CACHE_MAX_BYTES", len(body) + 5)
        _clear_file_cache()

        load_jsonl_from_s3("test-bucket", "bytes/a.jsonl")
        load_jsonl_from_s3("test-bucket", "bytes/b.jsonl")

        assert "s3://test-bucket/bytes/b.jsonl" in main_module._file_cache
        assert "s3://test-bucket/bytes/a.jsonl" not in main_module._file_cache


class TestCachePutConcurrency:
    def test_concurrent_cache_put_never_raises(self, monkeypatch):
        """Batch loading runs up to 10 threadpool workers through _cache_put
        concurrently; insert+evict must be atomic (regression: unlocked
        eviction loop raised RuntimeError/KeyError under contention)."""
        import threading

        import backend.main as main_module
        from backend.main import _cache_put, _clear_file_cache

        monkeypatch.setattr(main_module, "_FILE_CACHE_MAX_BYTES", 500)
        _clear_file_cache()
        errors = []

        def worker(worker_id):
            try:
                for i in range(300):
                    _cache_put(f"k{worker_id}-{i % 7}", i, [i], nbytes=100)
            except Exception as e:  # noqa: BLE001 — the test IS about exceptions
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(w,)) for w in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f"concurrent _cache_put raised: {errors[:3]}"
        assert len(main_module._file_cache) <= main_module._FILE_CACHE_MAX
