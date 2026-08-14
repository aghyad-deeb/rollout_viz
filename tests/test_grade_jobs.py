"""Persistent grading jobs: incremental flush, durability, reattach, cancel."""
import asyncio
import json

import pytest
from unittest.mock import patch, AsyncMock, MagicMock

import backend.main as main
from backend.llm_providers import GradeResult


def _gr(grade=True):
    return GradeResult(
        grade=grade, grade_type="bool", quotes=[], explanation="t",
        model="test-model", prompt_version="v1", timestamp="2026-01-15T10:00:00",
    )


def _events(text):
    return [json.loads(ln[6:]) for ln in text.split("\n") if ln.startswith("data: ")]


def _viz_grade_count(viz_path, metric):
    """Count samples in the viz file that have >=1 grade for `metric`."""
    n = 0
    with open(viz_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            s = json.loads(line)
            if s.get("grades", {}).get(metric):
                n += 1
    return n


def _req(file_path, sample_ids, **over):
    body = {
        "file_path": str(file_path),
        "sample_ids": sample_ids,
        "metric_name": "intended_to_cheat",
        "metric_prompt": "Did it cheat?",
        "grade_type": "bool",
        "provider": "openai",
        "model": "gpt-4o",
        "api_key": "test-key",
        "require_quotes": False,
        "parallel_size": 8,
    }
    body.update(over)
    return body


@pytest.mark.asyncio
class TestPersistentGrading:
    async def test_grades_flush_to_viz_in_batches(self, app_no_auth, temp_jsonl, patch_project_root, sample_data, monkeypatch):
        # 5 copies → 25 samples; flush every 5 → multiple incremental writes, not one.
        rows = (sample_data * 6)[:25]
        file_path = temp_jsonl(rows, "batch.jsonl")
        monkeypatch.setattr(main, "_FLUSH_EVERY_N", 5)
        monkeypatch.setattr(main, "_FLUSH_EVERY_S", 0)  # count-trigger only, no time gate

        save_spy = AsyncMock(side_effect=main._save_grades_for_file)
        provider = MagicMock()
        provider.grade_sample = AsyncMock(return_value=_gr())

        with patch("backend.main._save_grades_for_file", save_spy), \
             patch("backend.main.get_provider", return_value=provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json=_req(file_path, list(range(25))))
            await client.aclose()

        evs = _events(resp.text)
        complete = [e for e in evs if e["type"] == "complete"][0]
        assert complete["graded_count"] == 25
        # batched: >=5 flushes for 25 samples at N=5 (not a single end-of-job write)
        assert save_spy.await_count >= 3
        viz_path = main.get_viz_path(str(file_path))
        assert _viz_grade_count(viz_path, "intended_to_cheat") == 25

    async def test_job_survives_reader_disconnect(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        rows = (sample_data * 3)[:12]
        file_path = temp_jsonl(rows, "detach.jsonl")

        async def slow(**kw):
            await asyncio.sleep(0.03)
            return _gr()
        provider = MagicMock()
        provider.grade_sample = AsyncMock(side_effect=slow)

        with patch("backend.main.get_provider", return_value=provider):
            client = await app_no_auth()
            job_id = None
            # Read just the 'started' event, then disconnect (exit the stream early).
            async with client.stream("POST", "/api/grade-stream", json=_req(file_path, list(range(12)))) as resp:
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        ev = json.loads(line[6:])
                        if ev.get("type") == "started":
                            job_id = ev["job_id"]
                            break
            assert job_id is not None
            # The job is detached: it keeps running after we stopped reading.
            for _ in range(200):
                job = main._GRADE_JOBS.get(job_id)
                if job and job.status == "complete":
                    break
                await asyncio.sleep(0.05)
            await client.aclose()

        job = main._GRADE_JOBS[job_id]
        assert job.status == "complete"
        viz_path = main.get_viz_path(str(file_path))
        assert _viz_grade_count(viz_path, "intended_to_cheat") == 12

    async def test_reattach_to_finished_job_replays_terminal(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data[:3], "reattach.jsonl")
        provider = MagicMock()
        provider.grade_sample = AsyncMock(return_value=_gr())

        with patch("backend.main.get_provider", return_value=provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json=_req(file_path, [0, 1, 2]))
            started = [e for e in _events(resp.text) if e["type"] == "started"][0]
            job_id = started["job_id"]

            jobs = (await client.get("/api/grade-jobs")).json()
            assert any(j["job_id"] == job_id for j in jobs)

            reattach = await client.get(f"/api/grade-jobs/{job_id}/stream")
            revs = _events(reattach.text)
            assert revs[0]["type"] == "snapshot"
            assert any(e["type"] == "complete" and e["graded_count"] == 3 for e in revs)
            await client.aclose()

    async def test_cancel_endpoint(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data[:2], "cancel.jsonl")
        provider = MagicMock()
        provider.grade_sample = AsyncMock(return_value=_gr())
        with patch("backend.main.get_provider", return_value=provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json=_req(file_path, [0, 1]))
            job_id = [e for e in _events(resp.text) if e["type"] == "started"][0]["job_id"]

            # Unknown job → 404
            missing = await client.post("/api/grade-jobs/deadbeef/cancel")
            assert missing.status_code == 404
            # Known job → sets the cooperative cancel flag
            ok = await client.post(f"/api/grade-jobs/{job_id}/cancel")
            assert ok.status_code == 200 and ok.json()["cancelled"] is True
            assert main._GRADE_JOBS[job_id].cancel_requested is True
            await client.aclose()

    async def test_one_active_job_per_file_errors_with_job_id(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data[:2], "dup.jsonl")
        # Pre-register a fake RUNNING job for this file.
        lock_key = main._grade_lock_key(str(file_path))
        fake = MagicMock()
        fake.status = "running"
        fake.job_id = "existing123"
        main._GRADE_JOBS["existing123"] = fake
        main._GRADE_JOBS_BY_FILE[lock_key] = "existing123"

        provider = MagicMock()
        provider.grade_sample = AsyncMock(return_value=_gr())
        with patch("backend.main.get_provider", return_value=provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json=_req(file_path, [0, 1]))
            evs = _events(resp.text)
            err = [e for e in evs if e["type"] == "error"]
            assert err and err[0].get("job_id") == "existing123"
            await client.aclose()
