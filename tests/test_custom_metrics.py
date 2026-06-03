"""Tests for custom metrics CRUD and preset metrics."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch


class TestPresetMetrics:
    """Tests for GET /api/preset-metrics."""

    async def test_includes_five_builtins(self, app_no_auth):
        client = await app_no_auth()
        resp = await client.get("/api/preset-metrics")
        assert resp.status_code == 200
        data = resp.json()
        assert "helpfulness" in data
        assert "accuracy" in data
        assert "safety" in data
        assert "coherence" in data
        assert "task_completion" in data
        await client.aclose()

    async def test_includes_custom_from_file(self, app_no_auth, tmp_path):
        custom = {"my_metric": {"name": "My Metric", "description": "test", "grade_type": "bool", "prompt": "test", "is_custom": True}}
        custom_file = tmp_path / "custom_metrics.json"
        custom_file.write_text(json.dumps(custom))

        with patch("backend.main.CUSTOM_METRICS_FILE", custom_file):
            client = await app_no_auth()
            resp = await client.get("/api/preset-metrics")
            data = resp.json()
            assert "my_metric" in data
            assert data["my_metric"]["is_custom"] is True
            await client.aclose()


class TestSaveCustomMetric:
    """Tests for POST /api/save-custom-metric."""

    async def test_save_creates_metric(self, app_no_auth, tmp_path):
        custom_file = tmp_path / "custom_metrics.json"
        with patch("backend.main.CUSTOM_METRICS_FILE", custom_file):
            client = await app_no_auth()
            resp = await client.post("/api/save-custom-metric", json={
                "key": "my_metric",
                "name": "My Metric",
                "description": "A test metric",
                "grade_type": "float",
                "prompt": "Rate this from 0 to 1",
            })
            assert resp.status_code == 200
            assert resp.json()["status"] == "saved"

            # Verify file was written
            saved = json.loads(custom_file.read_text())
            assert "my_metric" in saved
            await client.aclose()

    async def test_key_normalized(self, app_no_auth, tmp_path):
        custom_file = tmp_path / "custom_metrics.json"
        with patch("backend.main.CUSTOM_METRICS_FILE", custom_file):
            client = await app_no_auth()
            resp = await client.post("/api/save-custom-metric", json={
                "key": "My Custom Metric",
                "name": "My Custom Metric",
                "description": "test",
                "grade_type": "bool",
                "prompt": "test",
            })
            assert resp.json()["key"] == "my_custom_metric"
            await client.aclose()

    async def test_save_accepts_freeform_metric(self, app_no_auth, tmp_path):
        custom_file = tmp_path / "custom_metrics.json"
        with patch("backend.main.CUSTOM_METRICS_FILE", custom_file):
            client = await app_no_auth()
            resp = await client.post("/api/save-custom-metric", json={
                "key": "grader_summary",
                "name": "Grader Summary",
                "description": "Summarize grader awareness",
                "grade_type": "freeform",
                "prompt": "Describe the behavior",
            })
            assert resp.status_code == 200
            saved = json.loads(custom_file.read_text())
            assert saved["grader_summary"]["grade_type"] == "freeform"
            await client.aclose()

    async def test_cannot_override_preset(self, app_no_auth, tmp_path):
        custom_file = tmp_path / "custom_metrics.json"
        with patch("backend.main.CUSTOM_METRICS_FILE", custom_file):
            client = await app_no_auth()
            resp = await client.post("/api/save-custom-metric", json={
                "key": "helpfulness",
                "name": "Helpfulness",
                "description": "override attempt",
                "grade_type": "float",
                "prompt": "override",
            })
            assert resp.status_code == 400
            await client.aclose()


class TestDeleteCustomMetric:
    """Tests for DELETE /api/custom-metric/{key}."""

    async def test_delete_removes(self, app_no_auth, tmp_path):
        custom_file = tmp_path / "custom_metrics.json"
        custom_file.write_text(json.dumps({"to_delete": {"name": "X", "description": "x", "grade_type": "bool", "prompt": "x", "is_custom": True}}))

        with patch("backend.main.CUSTOM_METRICS_FILE", custom_file):
            client = await app_no_auth()
            resp = await client.delete("/api/custom-metric/to_delete")
            assert resp.status_code == 200
            assert resp.json()["status"] == "deleted"

            saved = json.loads(custom_file.read_text())
            assert "to_delete" not in saved
            await client.aclose()

    async def test_delete_nonexistent_404(self, app_no_auth, tmp_path):
        custom_file = tmp_path / "custom_metrics.json"
        custom_file.write_text("{}")

        with patch("backend.main.CUSTOM_METRICS_FILE", custom_file):
            client = await app_no_auth()
            resp = await client.delete("/api/custom-metric/nonexistent")
            assert resp.status_code == 404
            await client.aclose()
