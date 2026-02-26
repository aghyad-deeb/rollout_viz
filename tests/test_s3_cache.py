"""Tests for S3 ETag-based caching, cache invalidation after saves, and boto3 config."""

import json
import time
from unittest.mock import patch

import pytest


@pytest.mark.performance
class TestS3ETagCache:
    """Tests for S3 ETag-based content caching in _file_cache."""

    def test_s3_cache_second_load_skips_get_object(self, mock_s3):
        """Second load of same S3 file does NOT call get_object again."""
        from backend.main import load_jsonl_from_s3, _get_s3_client, _reset_s3_client
        _reset_s3_client()

        bucket = mock_s3["bucket"]
        key = "data/traces.jsonl"

        # First load — populates cache
        result1 = load_jsonl_from_s3(bucket, key)
        assert len(result1) == 2

        # Wrap get_object with a counter
        client = _get_s3_client()
        original_get = client.get_object
        call_count = [0]

        def counting_get(*args, **kwargs):
            call_count[0] += 1
            return original_get(*args, **kwargs)

        client.get_object = counting_get

        # Second load — should use cache, no get_object call
        result2 = load_jsonl_from_s3(bucket, key)
        assert len(result2) == 2
        assert call_count[0] == 0, f"get_object called {call_count[0]} times, expected 0 (cached)"

    def test_s3_cache_invalidated_when_content_changes(self, mock_s3):
        """Changing S3 content (new ETag) causes cache miss and returns new data."""
        from backend.main import load_jsonl_from_s3, _reset_s3_client
        _reset_s3_client()

        bucket = mock_s3["bucket"]
        key = "data/traces.jsonl"

        # First load
        result1 = load_jsonl_from_s3(bucket, key)
        assert len(result1) == 2

        # Upload new content (different ETag)
        new_sample = json.dumps({
            "messages": [{"role": "user", "content": "New!"}],
            "attributes": {"step": 99, "rollout_n": 99, "reward": 9.9},
            "timestamp": "2026-02-25T12:00:00",
        })
        mock_s3["s3"].put_object(
            Bucket=bucket, Key=key, Body=new_sample + "\n"
        )

        # Second load — should detect ETag change and return new content
        result2 = load_jsonl_from_s3(bucket, key)
        assert len(result2) == 1
        assert result2[0]["messages"][0]["content"] == "New!"

    def test_s3_cache_key_uses_s3_uri(self, mock_s3):
        """Cache key for S3 files uses the s3://bucket/key format."""
        from backend.main import load_jsonl_from_s3, _file_cache, _reset_s3_client
        _reset_s3_client()

        bucket = mock_s3["bucket"]
        key = "data/traces.jsonl"
        load_jsonl_from_s3(bucket, key)

        expected_key = f"s3://{bucket}/{key}"
        assert expected_key in _file_cache, f"Expected cache key '{expected_key}', got: {list(_file_cache.keys())}"

    def test_s3_cache_respects_max_size(self, mock_s3):
        """Cache evicts entries when exceeding _FILE_CACHE_MAX (20)."""
        from backend.main import load_jsonl_from_s3, _file_cache, _reset_s3_client, _FILE_CACHE_MAX
        _reset_s3_client()

        bucket = mock_s3["bucket"]

        # Create 21 unique S3 files
        for i in range(21):
            sample = json.dumps({
                "messages": [{"role": "user", "content": f"File {i}"}],
                "attributes": {"step": i, "rollout_n": i, "reward": 0.0},
                "timestamp": "2026-01-15T10:00:00",
            })
            mock_s3["s3"].put_object(
                Bucket=bucket, Key=f"data/file_{i}.jsonl", Body=sample + "\n"
            )

        # Load all 21 files
        for i in range(21):
            load_jsonl_from_s3(bucket, f"data/file_{i}.jsonl")

        assert len(_file_cache) <= _FILE_CACHE_MAX, (
            f"Cache has {len(_file_cache)} entries, expected <= {_FILE_CACHE_MAX}"
        )


@pytest.mark.performance
class TestCacheInvalidationAfterSaves:
    """Tests for cache invalidation when saving files."""

    def test_save_local_invalidates_file_cache(self, tmp_path, patch_project_root):
        """Saving a local file invalidates its _file_cache entry so next load returns new data."""
        from backend.main import (
            load_jsonl_from_file, save_jsonl_to_file, _file_cache
        )

        file_path = tmp_path / "cache_inv.jsonl"
        original_samples = [
            {"messages": [{"role": "user", "content": "v1"}], "timestamp": ""}
        ]
        with open(file_path, 'w') as f:
            for s in original_samples:
                f.write(json.dumps(s) + "\n")

        # Load to populate cache
        result1 = load_jsonl_from_file(str(file_path))
        assert result1[0]["messages"][0]["content"] == "v1"

        # Save new content via save_jsonl_to_file
        new_samples = [
            {"messages": [{"role": "user", "content": "v2"}], "timestamp": ""}
        ]
        save_jsonl_to_file(str(file_path), new_samples)

        # Next load should return new content, not stale cache
        result2 = load_jsonl_from_file(str(file_path))
        assert result2[0]["messages"][0]["content"] == "v2"

    def test_save_s3_invalidates_file_cache(self, mock_s3):
        """Saving to S3 invalidates the S3 _file_cache entry."""
        from backend.main import (
            load_jsonl_from_s3, save_jsonl_to_s3, _file_cache, _reset_s3_client
        )
        _reset_s3_client()

        bucket = mock_s3["bucket"]
        key = "data/traces.jsonl"

        # Load to populate cache
        result1 = load_jsonl_from_s3(bucket, key)
        cache_key = f"s3://{bucket}/{key}"
        assert cache_key in _file_cache

        # Save new content
        new_samples = [
            {"messages": [{"role": "user", "content": "saved!"}], "timestamp": ""}
        ]
        save_jsonl_to_s3(bucket, key, new_samples)

        # Cache entry should be removed
        assert cache_key not in _file_cache, "S3 cache entry was not invalidated after save"

    def test_save_updates_viz_exists_cache(self, tmp_path, patch_project_root):
        """After saving to a viz/ path, viz_file_exists returns True immediately."""
        from backend.main import (
            viz_file_exists, save_jsonl_to_file, _viz_exists_cache
        )

        viz_path = str(tmp_path / "viz" / "test.jsonl")

        # Should not exist initially
        assert viz_file_exists(viz_path) is False

        # Save to that path
        save_jsonl_to_file(viz_path, [{"messages": [], "timestamp": ""}])

        # Should now exist (updated cache, no stale False)
        assert viz_file_exists(viz_path) is True


@pytest.mark.performance
class TestBoto3Config:
    """Tests for boto3 client configuration (pool size, timeouts, retries)."""

    def test_s3_client_has_custom_config(self, mock_s3):
        """S3 client should have max_pool_connections >= 25."""
        from backend.main import _get_s3_client, _reset_s3_client
        _reset_s3_client()
        client = _get_s3_client()
        config = client._client_config
        assert config.max_pool_connections >= 25, (
            f"max_pool_connections is {config.max_pool_connections}, expected >= 25"
        )

    def test_s3_client_has_timeouts(self, mock_s3):
        """S3 client should have connect_timeout=5 and read_timeout=30."""
        from backend.main import _get_s3_client, _reset_s3_client
        _reset_s3_client()
        client = _get_s3_client()
        config = client._client_config
        assert config.connect_timeout == 5, f"connect_timeout is {config.connect_timeout}, expected 5"
        assert config.read_timeout == 30, f"read_timeout is {config.read_timeout}, expected 30"
