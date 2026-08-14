"""Tests for JSONL parsing, sample loading, viz/ priority, and attribute defaults."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch


class TestLoadJsonlFromFile:
    """Tests for load_jsonl_from_file()."""

    def test_valid_jsonl_parse(self, temp_jsonl, patch_project_root, sample_data):
        """Valid JSONL file parsed correctly."""
        from backend.main import load_jsonl_from_file
        file_path = temp_jsonl(sample_data, "test.jsonl")
        result = load_jsonl_from_file(str(file_path))
        assert len(result) == 5
        assert result[0]["messages"][0]["role"] == "system"

    def test_empty_lines_skipped(self, patch_project_root):
        """Empty lines in JSONL are skipped."""
        from backend.main import load_jsonl_from_file
        file_path = patch_project_root / "with_blanks.jsonl"
        content = '{"messages": []}\n\n\n{"messages": [{"role": "user", "content": "hi"}]}\n'
        file_path.write_text(content)
        result = load_jsonl_from_file(str(file_path))
        assert len(result) == 2

    def test_malformed_line_raises(self, patch_project_root):
        """Malformed JSON line raises JSONDecodeError."""
        from backend.main import load_jsonl_from_file
        file_path = patch_project_root / "bad.jsonl"
        file_path.write_text('{"valid": true}\n{invalid json\n')
        with pytest.raises(json.JSONDecodeError):
            load_jsonl_from_file(str(file_path))

    def test_empty_file_returns_empty(self, patch_project_root):
        """Empty file returns empty list."""
        from backend.main import load_jsonl_from_file
        file_path = patch_project_root / "empty.jsonl"
        file_path.write_text("")
        result = load_jsonl_from_file(str(file_path))
        assert result == []

    def test_file_not_found_raises(self, patch_project_root):
        """Missing file raises FileNotFoundError."""
        from backend.main import load_jsonl_from_file
        with pytest.raises(FileNotFoundError):
            load_jsonl_from_file(str(patch_project_root / "nonexistent.jsonl"))


class TestAttributeProcessing:
    """Tests for attribute processing in _load_samples_sync."""

    def test_validate_renamed_to_is_validate(self, temp_jsonl, patch_project_root, sample_data):
        """'validate' attribute renamed to 'is_validate'."""
        from backend.main import _load_samples_sync
        file_path = temp_jsonl(sample_data, "test.jsonl")
        result = _load_samples_sync(str(file_path))
        # sample_data[0] has validate: False
        assert "is_validate" in result["samples"][0]["attributes"]
        assert "validate" not in result["samples"][0]["attributes"]

    def test_defaults_applied_for_missing_attrs(self, patch_project_root):
        """Missing attributes get default values."""
        from backend.main import _load_samples_sync
        minimal = [{"messages": [{"role": "user", "content": "hi"}]}]
        file_path = patch_project_root / "minimal.jsonl"
        file_path.write_text(json.dumps(minimal[0]) + "\n")
        result = _load_samples_sync(str(file_path))
        attrs = result["samples"][0]["attributes"]
        assert attrs["step"] == 0
        assert attrs["sample_index"] == 0
        assert attrs["rollout_n"] == 0
        assert attrs["reward"] == 0.0
        assert attrs["data_source"] == "unknown"
        assert attrs["experiment_name"] == "unknown"
        assert attrs["is_validate"] is False

    def test_extra_attrs_preserved(self, patch_project_root):
        """Extra attributes not in defaults are preserved."""
        from backend.main import _load_samples_sync
        sample = {
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {"custom_field": "custom_value", "step": 5},
        }
        file_path = patch_project_root / "extra.jsonl"
        file_path.write_text(json.dumps(sample) + "\n")
        result = _load_samples_sync(str(file_path))
        attrs = result["samples"][0]["attributes"]
        assert attrs["custom_field"] == "custom_value"
        assert attrs["step"] == 5

    def test_sequential_ids(self, temp_jsonl, patch_project_root, sample_data):
        """Samples get sequential IDs starting from 0."""
        from backend.main import _load_samples_sync
        file_path = temp_jsonl(sample_data, "test.jsonl")
        result = _load_samples_sync(str(file_path))
        for i, sample in enumerate(result["samples"]):
            assert sample["id"] == i

    def test_experiment_name_from_first_sample(self, temp_jsonl, patch_project_root, sample_data):
        """experiment_name taken from first sample's attributes."""
        from backend.main import _load_samples_sync
        file_path = temp_jsonl(sample_data, "test.jsonl")
        result = _load_samples_sync(str(file_path))
        assert result["experiment_name"] == "test_experiment"

    def test_has_grades_true_when_grades_present(self, patch_project_root):
        """has_grades is True when any sample has grades."""
        from backend.main import _load_samples_sync
        sample = {
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {"step": 1},
            "grades": {"helpfulness": [{"grade": 0.8, "grade_type": "float"}]},
        }
        file_path = patch_project_root / "graded.jsonl"
        file_path.write_text(json.dumps(sample) + "\n")
        result = _load_samples_sync(str(file_path))
        assert result["has_grades"] is True

    def test_has_grades_false_when_no_grades(self, temp_jsonl, patch_project_root, sample_data):
        """has_grades is False when no grades present."""
        from backend.main import _load_samples_sync
        file_path = temp_jsonl(sample_data, "test.jsonl")
        result = _load_samples_sync(str(file_path))
        assert result["has_grades"] is False


class TestVizPath:
    """Tests for get_viz_path() and viz file priority."""

    def test_local_viz_path(self):
        """Local path transforms to viz/ subdirectory."""
        from backend.main import get_viz_path
        assert get_viz_path("/path/to/file.jsonl") == "/path/to/viz/file.jsonl"

    def test_s3_viz_path(self):
        """S3 path transforms to viz/ subdirectory."""
        from backend.main import get_viz_path
        assert get_viz_path("s3://bucket/path/file.jsonl") == "s3://bucket/path/viz/file.jsonl"

    def test_s3_viz_path_no_prefix(self):
        """S3 path without prefix gets viz/."""
        from backend.main import get_viz_path
        assert get_viz_path("s3://bucket/file.jsonl") == "s3://bucket/viz/file.jsonl"

    def test_viz_preferred_when_exists(self, patch_project_root, sample_data):
        """Viz file is used when it exists."""
        from backend.main import _load_samples_sync
        # Create original file
        original = patch_project_root / "test.jsonl"
        original.write_text(json.dumps(sample_data[0]) + "\n")

        # Create viz/ version with different content
        viz_dir = patch_project_root / "viz"
        viz_dir.mkdir()
        viz_file = viz_dir / "test.jsonl"
        modified_sample = {**sample_data[0], "timestamp": "MODIFIED"}
        viz_file.write_text(json.dumps(modified_sample) + "\n")

        result = _load_samples_sync(str(original))
        assert result["samples"][0]["timestamp"] == "MODIFIED"
        assert result["has_grades"] is True  # viz presence sets has_grades

    def test_original_used_when_no_viz(self, patch_project_root, sample_data):
        """Original file used when viz/ doesn't exist."""
        from backend.main import _load_samples_sync
        original = patch_project_root / "test.jsonl"
        original.write_text(json.dumps(sample_data[0]) + "\n")

        result = _load_samples_sync(str(original))
        assert result["samples"][0]["timestamp"] == sample_data[0]["timestamp"]


class TestLoadSingleSample:
    """Tests for _load_single_sample_sync."""

    def test_valid_id(self, temp_jsonl, patch_project_root, sample_data):
        """Valid ID returns correct sample."""
        from backend.main import _load_single_sample_sync
        file_path = temp_jsonl(sample_data, "test.jsonl")
        result = _load_single_sample_sync(str(file_path), 0)
        assert result["id"] == 0
        assert result["messages"][0]["role"] == "system"

    def test_out_of_bounds_raises(self, temp_jsonl, patch_project_root, sample_data):
        """Out-of-bounds ID raises HTTPException."""
        from backend.main import _load_single_sample_sync
        from fastapi import HTTPException
        file_path = temp_jsonl(sample_data, "test.jsonl")
        with pytest.raises(HTTPException) as exc_info:
            _load_single_sample_sync(str(file_path), 999)
        assert exc_info.value.status_code == 404

    def test_negative_id_raises(self, temp_jsonl, patch_project_root, sample_data):
        """Negative ID raises HTTPException."""
        from backend.main import _load_single_sample_sync
        from fastapi import HTTPException
        file_path = temp_jsonl(sample_data, "test.jsonl")
        with pytest.raises(HTTPException) as exc_info:
            _load_single_sample_sync(str(file_path), -1)
        assert exc_info.value.status_code == 404


class TestSingleSampleVizAndGrades:
    """Tests for _load_single_sample_sync viz/ and grades support."""

    def test_single_sample_includes_grades(self, patch_project_root):
        """Single sample endpoint returns grades when present."""
        from backend.main import _load_single_sample_sync
        sample = {
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {"step": 1},
            "grades": {"helpfulness": [{"grade": 0.8, "grade_type": "float"}]},
        }
        file_path = patch_project_root / "graded.jsonl"
        file_path.write_text(json.dumps(sample) + "\n")
        result = _load_single_sample_sync(str(file_path), 0)
        assert result["grades"] is not None
        assert "helpfulness" in result["grades"]

    def test_single_sample_checks_viz_path(self, patch_project_root, sample_data):
        """Single sample endpoint loads from viz/ when it exists."""
        from backend.main import _load_single_sample_sync
        # Create original file
        original = patch_project_root / "test.jsonl"
        original.write_text(json.dumps(sample_data[0]) + "\n")

        # Create viz/ version with grades
        viz_dir = patch_project_root / "viz"
        viz_dir.mkdir()
        viz_file = viz_dir / "test.jsonl"
        modified_sample = {
            **sample_data[0],
            "grades": {"accuracy": [{"grade": True, "grade_type": "bool"}]},
        }
        viz_file.write_text(json.dumps(modified_sample) + "\n")

        result = _load_single_sample_sync(str(original), 0)
        assert result["grades"] is not None
        assert "accuracy" in result["grades"]

    def test_single_sample_returns_message_count(self, patch_project_root, sample_data):
        """Single sample endpoint includes message_count."""
        from backend.main import _load_single_sample_sync
        file_path = patch_project_root / "test.jsonl"
        file_path.write_text(json.dumps(sample_data[0]) + "\n")
        result = _load_single_sample_sync(str(file_path), 0)
        assert result["message_count"] == 3  # sample_data[0] has 3 messages


class TestSamplesEndpoint:
    """Tests for GET /api/samples endpoint."""

    async def test_response_has_all_fields(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        """Response has samples, total, experiment_name, file_path, has_grades."""
        file_path = temp_jsonl(sample_data, "test.jsonl")
        client = await app_no_auth()
        resp = await client.get(f"/api/samples?file={file_path}")
        assert resp.status_code == 200
        data = resp.json()
        assert "samples" in data
        assert "total" in data
        assert "experiment_name" in data
        assert "file_path" in data
        assert "has_grades" in data
        assert data["total"] == 5
        await client.aclose()

    async def test_file_not_found_returns_404(self, app_no_auth, patch_project_root):
        """Nonexistent file returns 404."""
        client = await app_no_auth()
        resp = await client.get("/api/samples?file=nonexistent.jsonl")
        assert resp.status_code == 404
        await client.aclose()


class TestBatchMetadataOnly:
    """Tests for POST /api/samples/batch with metadata_only=true."""

    async def test_batch_metadata_only_omits_messages(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        """metadata_only=true returns samples with empty messages."""
        file_path = temp_jsonl(sample_data, "test.jsonl")
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [str(file_path)],
            "metadata_only": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 5
        for sample in data["samples"]:
            assert sample["messages"] == []
        await client.aclose()

    async def test_batch_metadata_only_includes_message_count(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        """metadata_only=true includes message_count matching actual message count."""
        file_path = temp_jsonl(sample_data, "test.jsonl")
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [str(file_path)],
            "metadata_only": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        # sample_data[0] has 3 messages, sample_data[1] has 2 messages, etc.
        expected_counts = [3, 2, 2, 3, 2]
        for i, sample in enumerate(data["samples"]):
            assert sample["message_count"] == expected_counts[i], f"sample {i}: expected {expected_counts[i]}, got {sample.get('message_count')}"
        await client.aclose()

    async def test_batch_metadata_only_includes_grades(self, app_no_auth, patch_project_root):
        """metadata_only=true still includes grades."""
        sample = {
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {"step": 1},
            "grades": {"helpfulness": [{"grade": 0.8, "grade_type": "float"}]},
        }
        file_path = patch_project_root / "graded.jsonl"
        file_path.write_text(json.dumps(sample) + "\n")
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [str(file_path)],
            "metadata_only": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["samples"][0]["grades"] is not None
        assert "helpfulness" in data["samples"][0]["grades"]
        await client.aclose()

    async def test_batch_metadata_only_allows_gzip(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        """metadata_only=true does NOT set Content-Encoding: identity (allows gzip)."""
        file_path = temp_jsonl(sample_data, "test.jsonl")
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [str(file_path)],
            "metadata_only": True,
        })
        assert resp.status_code == 200
        # Should NOT have Content-Encoding: identity (which blocks gzip)
        assert resp.headers.get("content-encoding") != "identity"
        await client.aclose()

    async def test_batch_full_backward_compat(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        """Default metadata_only=false still returns full messages (no regression)."""
        file_path = temp_jsonl(sample_data, "test.jsonl")
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [str(file_path)],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 5
        # Messages should be present (not empty)
        for sample in data["samples"]:
            assert len(sample["messages"]) > 0
        await client.aclose()

    async def test_batch_message_count_present_in_full_mode(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        """message_count is also present in full mode (for consistency)."""
        file_path = temp_jsonl(sample_data, "test.jsonl")
        client = await app_no_auth()
        resp = await client.post("/api/samples/batch", json={
            "files": [str(file_path)],
        })
        assert resp.status_code == 200
        data = resp.json()
        for sample in data["samples"]:
            assert "message_count" in sample
            assert sample["message_count"] == len(sample["messages"])
        await client.aclose()


class TestDiagnosticsPassthrough:
    """Producers write sample-level diagnostics[] (e.g. 'display reconstruction
    from samples.jsonl...'); the viewer must surface them, not drop them."""

    async def test_samples_endpoint_passes_diagnostics_through(self, app_no_auth, patch_project_root):
        import json as _json
        entry = {
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {"rollout_n": 1},
            "diagnostics": ["Display reconstruction; raw arrays under raw.sample_jsonl_entry."],
            "timestamp": "2026-06-06T00:00:00",
        }
        p = patch_project_root / "diag.jsonl"
        p.write_text(_json.dumps(entry) + "\n")

        client = await app_no_auth()
        resp = await client.get("/api/samples", params={"file": "diag.jsonl"})
        assert resp.status_code == 200
        sample = resp.json()["samples"][0]
        assert sample["diagnostics"] == entry["diagnostics"]
        await client.aclose()

    async def test_absent_diagnostics_is_null(self, app_no_auth, patch_project_root):
        import json as _json
        entry = {"messages": [{"role": "user", "content": "hi"}], "attributes": {}, "timestamp": ""}
        p = patch_project_root / "nodiag.jsonl"
        p.write_text(_json.dumps(entry) + "\n")

        client = await app_no_auth()
        resp = await client.get("/api/samples", params={"file": "nodiag.jsonl"})
        sample = resp.json()["samples"][0]
        assert sample.get("diagnostics") is None
        await client.aclose()

    async def test_fetch_api_includes_diagnostics(self, app_no_auth, patch_project_root):
        import json as _json
        entry = {
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {"rollout_n": 1},
            "diagnostics": ["truncated at 10 turns"],
            "timestamp": "",
        }
        p = patch_project_root / "diag2.jsonl"
        p.write_text(_json.dumps(entry) + "\n")

        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": "diag2.jsonl", "index": 0})
        assert resp.json()["sample"]["diagnostics"] == ["truncated at 10 turns"]
        await client.aclose()


class TestBatchRawBytes:
    async def test_batch_metadata_reports_total_raw_bytes(self, app_no_auth, patch_project_root):
        """The frontend size-gates bulk hydration on this — a sample-count
        threshold alone misses few-but-huge agentic rollouts."""
        import json as _json
        p = patch_project_root / "sized.jsonl"
        entry = {"messages": [{"role": "user", "content": "x" * 500}], "attributes": {}, "timestamp": ""}
        p.write_text((_json.dumps(entry) + "\n") * 3)

        client = await app_no_auth()
        resp = await client.post(
            "/api/samples/batch", json={"files": ["sized.jsonl"], "metadata_only": True}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_raw_bytes"] == p.stat().st_size
        await client.aclose()
