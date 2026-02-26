"""Tests for the batch samples loading endpoint POST /api/samples/batch."""

import json

import pytest


class TestLoadSamplesBatchSync:
    """Tests for the _load_samples_batch_sync helper function."""

    def _make_file(self, tmp_path, filename, samples):
        """Helper to write a JSONL file."""
        file_path = tmp_path / filename
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w") as f:
            for s in samples:
                f.write(json.dumps(s) + "\n")
        return str(file_path)

    def _make_sample(self, content="Hello", step=1, rollout_n=0, reward=0.5,
                     experiment_name="exp1", validate=None, grades=None):
        """Helper to create a sample dict."""
        attrs = {
            "step": step,
            "rollout_n": rollout_n,
            "reward": reward,
            "experiment_name": experiment_name,
        }
        if validate is not None:
            attrs["validate"] = validate
        s = {
            "messages": [{"role": "user", "content": content}],
            "attributes": attrs,
            "timestamp": "2026-01-15T10:00:00",
        }
        if grades is not None:
            s["grades"] = grades
        return s

    def test_batch_returns_combined_samples(self, tmp_path, patch_project_root):
        """Two files with 2 and 3 samples → 5 combined samples."""
        from backend.main import _load_samples_batch_sync

        f1 = self._make_file(tmp_path, "a.jsonl", [
            self._make_sample("Q1", step=1, rollout_n=0),
            self._make_sample("Q2", step=2, rollout_n=1),
        ])
        f2 = self._make_file(tmp_path, "b.jsonl", [
            self._make_sample("Q3", step=1, rollout_n=0),
            self._make_sample("Q4", step=2, rollout_n=1),
            self._make_sample("Q5", step=3, rollout_n=2),
        ])

        result = _load_samples_batch_sync([f1, f2])
        assert result["total"] == 5
        assert len(result["samples"]) == 5

    def test_batch_sequential_ids(self, tmp_path, patch_project_root):
        """IDs are 0,1,2,3,4 across files."""
        from backend.main import _load_samples_batch_sync

        f1 = self._make_file(tmp_path, "a.jsonl", [
            self._make_sample("Q1"),
            self._make_sample("Q2"),
        ])
        f2 = self._make_file(tmp_path, "b.jsonl", [
            self._make_sample("Q3"),
            self._make_sample("Q4"),
            self._make_sample("Q5"),
        ])

        result = _load_samples_batch_sync([f1, f2])
        ids = [s["id"] for s in result["samples"]]
        assert ids == [0, 1, 2, 3, 4]

    def test_batch_source_file_injected(self, tmp_path, patch_project_root):
        """Each sample gets source_file attribute set to its origin file path."""
        from backend.main import _load_samples_batch_sync

        f1 = self._make_file(tmp_path, "a.jsonl", [self._make_sample("Q1")])
        f2 = self._make_file(tmp_path, "b.jsonl", [self._make_sample("Q2")])

        result = _load_samples_batch_sync([f1, f2])
        assert result["samples"][0]["attributes"]["source_file"] == f1
        assert result["samples"][1]["attributes"]["source_file"] == f2

    def test_batch_experiment_names_collected(self, tmp_path, patch_project_root):
        """Collects unique experiment names from all files."""
        from backend.main import _load_samples_batch_sync

        f1 = self._make_file(tmp_path, "a.jsonl", [
            self._make_sample("Q1", experiment_name="exp_alpha"),
        ])
        f2 = self._make_file(tmp_path, "b.jsonl", [
            self._make_sample("Q2", experiment_name="exp_beta"),
        ])
        f3 = self._make_file(tmp_path, "c.jsonl", [
            self._make_sample("Q3", experiment_name="exp_alpha"),  # duplicate
        ])

        result = _load_samples_batch_sync([f1, f2, f3])
        assert sorted(result["experiment_names"]) == ["exp_alpha", "exp_beta"]

    def test_batch_validate_renamed(self, tmp_path, patch_project_root):
        """validate attribute is renamed to is_validate."""
        from backend.main import _load_samples_batch_sync

        f1 = self._make_file(tmp_path, "a.jsonl", [
            self._make_sample("Q1", validate=True),
        ])

        result = _load_samples_batch_sync([f1])
        attrs = result["samples"][0]["attributes"]
        assert "is_validate" in attrs
        assert attrs["is_validate"] is True
        assert "validate" not in attrs

    def test_batch_viz_priority(self, tmp_path, patch_project_root):
        """When viz/ version exists, batch loads it instead of original."""
        from backend.main import _load_samples_batch_sync, _clear_viz_exists_cache

        # Original file
        self._make_file(tmp_path, "a.jsonl", [
            self._make_sample("original"),
        ])
        # viz/ version with grades
        self._make_file(tmp_path, "viz/a.jsonl", [
            self._make_sample("graded", grades={"helpfulness": [{"grade": True}]}),
        ])

        _clear_viz_exists_cache()
        f1 = str(tmp_path / "a.jsonl")
        result = _load_samples_batch_sync([f1])
        # Should load viz/ version
        assert result["samples"][0]["messages"][0]["content"] == "graded"

    def test_batch_empty_list(self, tmp_path, patch_project_root):
        """Empty file list returns empty result."""
        from backend.main import _load_samples_batch_sync

        result = _load_samples_batch_sync([])
        assert result["total"] == 0
        assert result["samples"] == []
        assert result["errors"] == []

    def test_batch_partial_failure(self, tmp_path, patch_project_root):
        """One bad file doesn't block others; errors are reported."""
        from backend.main import _load_samples_batch_sync

        f1 = self._make_file(tmp_path, "good.jsonl", [
            self._make_sample("Q1"),
        ])
        bad_path = str(tmp_path / "nonexistent.jsonl")

        result = _load_samples_batch_sync([f1, bad_path])
        # Good file's samples still present
        assert result["total"] == 1
        assert result["samples"][0]["messages"][0]["content"] == "Q1"
        # Error reported for bad file
        assert len(result["errors"]) == 1
        assert result["errors"][0]["file"] == bad_path


class TestBatchEndpoint:
    """Tests for the POST /api/samples/batch endpoint."""

    def _make_file(self, tmp_path, filename, samples):
        file_path = tmp_path / filename
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w") as f:
            for s in samples:
                f.write(json.dumps(s) + "\n")
        return str(file_path)

    def _make_sample(self, content="Hello", step=1, rollout_n=0, reward=0.5,
                     experiment_name="exp1"):
        return {
            "messages": [{"role": "user", "content": content}],
            "attributes": {
                "step": step, "rollout_n": rollout_n, "reward": reward,
                "experiment_name": experiment_name,
            },
            "timestamp": "2026-01-15T10:00:00",
        }

    @pytest.mark.asyncio
    async def test_batch_endpoint_returns_combined(self, app_no_auth, tmp_path, patch_project_root):
        """POST /api/samples/batch returns combined samples from multiple files."""
        f1 = self._make_file(tmp_path, "a.jsonl", [
            self._make_sample("Q1"),
            self._make_sample("Q2"),
        ])
        f2 = self._make_file(tmp_path, "b.jsonl", [
            self._make_sample("Q3"),
        ])

        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={"files": [f1, f2]})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 3
        assert len(data["samples"]) == 3
        # Sequential IDs
        assert [s["id"] for s in data["samples"]] == [0, 1, 2]
        await client.aclose()

    @pytest.mark.asyncio
    async def test_batch_endpoint_empty_files(self, app_no_auth):
        """Empty file list returns 200 with 0 samples."""
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={"files": []})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["samples"] == []
        await client.aclose()

    @pytest.mark.asyncio
    async def test_batch_endpoint_with_s3(self, app_no_auth, mock_s3):
        """Batch endpoint works with s3:// paths."""
        bucket = mock_s3["bucket"]
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [
                f"s3://{bucket}/data/traces.jsonl",
                f"s3://{bucket}/data/other.jsonl",
            ]
        })
        assert resp.status_code == 200
        data = resp.json()
        # traces.jsonl has 2 samples, other.jsonl has 1
        assert data["total"] == 3
        assert [s["id"] for s in data["samples"]] == [0, 1, 2]
        await client.aclose()

    @pytest.mark.asyncio
    async def test_batch_endpoint_auth_required(self, app_with_auth, tmp_path, patch_project_root):
        """Batch endpoint respects auth middleware."""
        f1 = self._make_file(tmp_path, "a.jsonl", [self._make_sample("Q1")])

        client = await app_with_auth()
        resp = await client.post("/api/samples/batch", json={"files": [f1]})
        # Should be rejected without auth
        assert resp.status_code == 401
        await client.aclose()

    @pytest.mark.asyncio
    async def test_batch_endpoint_source_file_in_response(self, app_no_auth, tmp_path, patch_project_root):
        """source_file attribute is set correctly in batch response."""
        f1 = self._make_file(tmp_path, "a.jsonl", [self._make_sample("Q1")])
        f2 = self._make_file(tmp_path, "b.jsonl", [self._make_sample("Q2")])

        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={"files": [f1, f2]})
        assert resp.status_code == 200
        data = resp.json()
        assert data["samples"][0]["attributes"]["source_file"] == f1
        assert data["samples"][1]["attributes"]["source_file"] == f2
        await client.aclose()


class TestBatchConcurrency:
    """Tests for concurrent S3 loading in batch."""

    @pytest.mark.asyncio
    async def test_batch_s3_concurrent_download(self, app_no_auth, mock_s3):
        """Loading 2 S3 files via batch returns correct combined data."""
        bucket = mock_s3["bucket"]
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [
                f"s3://{bucket}/data/traces.jsonl",
                f"s3://{bucket}/data/other.jsonl",
            ]
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 3
        # Check source_file is set
        assert data["samples"][0]["attributes"]["source_file"] == f"s3://{bucket}/data/traces.jsonl"
        assert data["samples"][2]["attributes"]["source_file"] == f"s3://{bucket}/data/other.jsonl"
        assert data["errors"] == []
        await client.aclose()
