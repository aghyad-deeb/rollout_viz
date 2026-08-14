"""Tests for grading: test-provider, SSE streaming, concurrency, quote retry, save."""

import json
import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from pathlib import Path

from backend.llm_providers import GradeResult, Quote


def _make_grade_result(grade=True, grade_type="bool", quotes=None, explanation="test"):
    """Helper to create a GradeResult."""
    return GradeResult(
        grade=grade,
        grade_type=grade_type,
        quotes=quotes or [],
        explanation=explanation,
        model="test-model",
        prompt_version="v1",
        timestamp="2026-01-15T10:00:00",
    )


class TestTestProvider:
    """Tests for POST /api/test-provider."""

    async def test_no_key_returns_400(self, app_no_auth):
        with patch("backend.main.get_env_api_key", return_value=None):
            client = await app_no_auth()
            resp = await client.post("/api/test-provider", json={
                "provider": "openai", "model": "gpt-4o"
            })
            assert resp.status_code == 400
            assert resp.json()["ok"] is False
            await client.aclose()

    async def test_valid_mocked_returns_ok(self, app_no_auth):
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result())

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            resp = await client.post("/api/test-provider", json={
                "provider": "openai", "model": "gpt-4o", "api_key": "test-key"
            })
            assert resp.status_code == 200
            assert resp.json()["ok"] is True
            await client.aclose()

    async def test_value_error_still_ok(self, app_no_auth):
        """ValueError from grade_sample means API connected but JSON was off — still ok."""
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(side_effect=ValueError("bad json"))

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            resp = await client.post("/api/test-provider", json={
                "provider": "openai", "model": "gpt-4o", "api_key": "test-key"
            })
            assert resp.status_code == 200
            assert resp.json()["ok"] is True
            await client.aclose()

    async def test_invalid_grade_response_still_ok(self, app_no_auth):
        """InvalidGradeResponse from grade_sample (router path) means API connected
        but the format was off — pre-flight still passes."""
        from backend.llm_providers import InvalidGradeResponse
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(
            side_effect=InvalidGradeResponse("missing explanation")
        )

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            resp = await client.post("/api/test-provider", json={
                "provider": "openai", "model": "gpt-4o", "api_key": "test-key"
            })
            assert resp.status_code == 200
            assert resp.json()["ok"] is True
            await client.aclose()

    async def test_connection_error_returns_not_ok(self, app_no_auth):
        """Connection error → ok=false."""
        with patch("backend.main.get_provider", side_effect=Exception("Connection refused")):
            client = await app_no_auth()
            resp = await client.post("/api/test-provider", json={
                "provider": "openai", "model": "gpt-4o", "api_key": "test-key"
            })
            assert resp.status_code == 400
            assert resp.json()["ok"] is False
            await client.aclose()

    async def test_forwards_router_provider_to_model_router(self, app_no_auth):
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result())

        with patch("backend.main.get_provider", return_value=mock_provider) as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/test-provider", json={
                "provider": "openai",
                "model": "gpt-4o",
                "router_provider": "litellm",
                "api_key": "test-key",
            })
            assert resp.status_code == 200
            assert resp.json()["ok"] is True
            assert get_provider.call_args.kwargs["router_provider"] == "litellm"
            await client.aclose()

    async def test_rejects_non_litellm_router_provider(self, app_no_auth):
        client = await app_no_auth()
        resp = await client.post("/api/test-provider", json={
            "provider": "openai",
            "model": "gpt-4o",
            "router_provider": "tinker",
            "api_key": "test-key",
        })
        assert resp.status_code == 400
        data = resp.json()
        assert data["ok"] is False
        assert "litellm" in data["error"].lower()
        await client.aclose()

    async def test_rejects_routed_model_id_with_direct_provider(self, app_no_auth):
        client = await app_no_auth()
        resp = await client.post("/api/test-provider", json={
            "provider": "google",
            "model": "openai/gpt-5.5",
            "api_key": "test-key",
        })
        assert resp.status_code == 400
        data = resp.json()
        assert data["ok"] is False
        assert "provider=openrouter" in data["error"]
        await client.aclose()


class TestTestProviderRateLimit:
    """Tests for the test-provider abuse rate limit."""

    async def test_x_forwarded_for_spoofing_does_not_bypass_limit(self, app_no_auth, monkeypatch):
        import backend.main as main_module

        monkeypatch.setattr(main_module, "_TEST_PROVIDER_RATE_LIMIT_MAX", 1)
        monkeypatch.setattr(main_module, "_TEST_PROVIDER_RATE_LIMIT_WINDOW", 60)
        monkeypatch.setattr(main_module, "VIZ_TRUSTED_PROXY_NETWORKS", [])

        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result())

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            first = await client.post(
                "/api/test-provider",
                json={"provider": "openai", "model": "gpt-4o", "api_key": "test-key"},
                headers={"x-forwarded-for": "203.0.113.1"},
            )
            second = await client.post(
                "/api/test-provider",
                json={"provider": "openai", "model": "gpt-4o", "api_key": "test-key"},
                headers={"x-forwarded-for": "203.0.113.2"},
            )

            assert first.status_code == 200
            assert first.json()["ok"] is True
            assert second.status_code == 429
            assert second.json()["ok"] is False
            assert mock_provider.grade_sample.await_count == 1
            await client.aclose()


class TestServerKeyAccess:
    """Server-side provider keys are only usable after password auth."""

    async def test_test_provider_denies_env_key_without_auth(self, app_no_auth, mock_env_config):
        mock_env_config(OPENAI_API_KEY="sk-server")
        with patch("backend.main.get_provider") as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/test-provider", json={
                "provider": "openai",
                "model": "gpt-4o",
            })
            assert resp.status_code == 403
            assert resp.json()["ok"] is False
            assert "authenticated password" in resp.json()["error"]
            get_provider.assert_not_called()
            await client.aclose()

    async def test_grade_denies_env_key_without_auth(self, app_no_auth, mock_env_config):
        mock_env_config(OPENAI_API_KEY="sk-server")
        with patch("backend.main.get_provider") as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/grade", json={
                "file_path": "unused.jsonl",
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
            })
            assert resp.status_code == 403
            assert "authenticated password" in resp.json()["detail"]
            get_provider.assert_not_called()
            await client.aclose()

    async def test_grade_stream_denies_env_key_without_auth(self, app_no_auth, mock_env_config):
        mock_env_config(OPENAI_API_KEY="sk-server")
        with patch("backend.main.get_provider") as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": "unused.jsonl",
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
            })
            events = TestGradeStream()._parse_sse_events(resp.text)
            assert resp.status_code == 200
            assert events[0]["type"] == "error"
            assert "authenticated password" in events[0]["message"]
            get_provider.assert_not_called()
            await client.aclose()

    async def test_authenticated_grade_can_use_env_key(self, authenticated_client, temp_jsonl, patch_project_root, sample_data, mock_env_config):
        mock_env_config(OPENAI_API_KEY="sk-server")
        file_path = temp_jsonl(sample_data, "test.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result(
            quotes=[Quote(message_index=1, channel="text", start=0, end=5, text="Hello")],
        ))

        with patch("backend.main.get_provider", return_value=mock_provider) as get_provider:
            client = await authenticated_client()
            resp = await client.post("/api/grade", json={
                "file_path": str(file_path),
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
            })
            assert resp.status_code == 200
            assert get_provider.call_args.args[1] == "sk-server"
            await client.aclose()


class TestGradeStream:
    """Tests for POST /api/grade-stream SSE endpoint."""

    def _parse_sse_events(self, text):
        """Parse SSE response text into list of event dicts."""
        events = []
        for line in text.split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
        return events

    async def test_progress_and_complete_events(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result(
            quotes=[Quote(message_index=1, channel="text", start=0, end=10, text="Good point")],
        ))

        with patch("backend.main.get_provider", return_value=mock_provider) as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": str(file_path),
                "sample_ids": [0, 1],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
                "parallel_size": 10,
                "max_tokens": 32768,
                "reasoning_effort": "low",
            })
            assert resp.status_code == 200
            events = self._parse_sse_events(resp.text)

            # Should have at least one progress and one complete event
            types = [e["type"] for e in events]
            assert "progress" in types
            assert "complete" in types

            # Complete event should have grades
            complete = [e for e in events if e["type"] == "complete"][0]
            assert complete["graded_count"] == 2
            assert len(complete["errors"]) == 0
            # Attempt budget decoupled from quote retries: full documented budget.
            assert get_provider.call_args.kwargs["max_attempts"] == 5
            assert get_provider.call_args.kwargs["max_tokens"] == 32768
            assert get_provider.call_args.kwargs["reasoning_effort"] == "low"
            await client.aclose()


    async def test_rejects_invalid_reasoning_effort(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        with patch("backend.main.get_provider") as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": str(file_path),
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
                "reasoning_effort": "extreme",
            })
            assert resp.status_code == 400
            assert "reasoning_effort" in resp.json()["detail"]
            get_provider.assert_not_called()
            await client.aclose()

    async def test_stream_accepts_more_than_legacy_1000_sample_cap(self, app_no_auth, temp_jsonl, patch_project_root):
        samples = [
            {
                "messages": [
                    {"role": "user", "content": f"Question {i}"},
                    {"role": "assistant", "content": f"Answer {i}"},
                ],
                "attributes": {
                    "step": i,
                    "sample_index": i,
                    "rollout_n": i,
                    "reward": 0.0,
                    "experiment_name": "large_grading_test",
                },
                "timestamp": "2026-01-15T10:00:00",
            }
            for i in range(1100)
        ]
        file_path = temp_jsonl(samples, "large_grade_stream.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result())

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": str(file_path),
                "sample_ids": list(range(1100)),
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
                "parallel_size": 100,
                "require_quotes": False,
            })
            assert resp.status_code == 200
            events = self._parse_sse_events(resp.text)
            assert [e for e in events if e["type"] == "error"] == []
            complete = [e for e in events if e["type"] == "complete"][0]
            assert complete["graded_count"] == 1100
            assert len(complete["errors"]) == 0
            assert mock_provider.grade_sample.await_count == 1100
            await client.aclose()

    async def test_error_event_on_failure(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(side_effect=Exception("API error"))

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": str(file_path),
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
            })
            events = self._parse_sse_events(resp.text)
            complete = [e for e in events if e["type"] == "complete"][0]
            assert len(complete["errors"]) == 1
            await client.aclose()

    async def test_provider_returned_grade_with_empty_quotes_is_saved(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        # The provider is the single source of truth for quotes. When it returns a
        # grade with empty quotes (having exhausted its quote-retry budget), the
        # grade must be SAVED, not discarded by a redundant second gate.
        file_path = temp_jsonl(sample_data, "test.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result(quotes=[]))

        with patch("backend.main.get_provider", return_value=mock_provider) as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": str(file_path),
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
                "require_quotes": True,
            })
            assert resp.status_code == 200
            events = self._parse_sse_events(resp.text)
            complete = [e for e in events if e["type"] == "complete"][0]
            assert complete["graded_count"] == 1
            assert len(complete["errors"]) == 0
            assert mock_provider.grade_sample.await_count == 1
            # Attempt budget is decoupled from quote retries: full documented budget.
            assert get_provider.call_args.kwargs["max_attempts"] == 5
            await client.aclose()

    async def test_complete_event_includes_failure_ratio_and_severity(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(side_effect=Exception("API error"))

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": str(file_path),
                "sample_ids": [0, 1],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
            })
            events = self._parse_sse_events(resp.text)
            complete = [e for e in events if e["type"] == "complete"][0]
            assert complete["failure_ratio"] == 1.0
            assert complete["severity"] == "warning"
            await client.aclose()

    async def test_no_api_key_sends_error_event(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        with patch("backend.main.get_env_api_key", return_value=None):
            client = await app_no_auth()
            resp = await client.post("/api/grade-stream", json={
                "file_path": str(file_path),
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
            })
            events = self._parse_sse_events(resp.text)
            error_events = [e for e in events if e["type"] == "error"]
            assert len(error_events) == 1
            assert "API key" in error_events[0]["message"] or "key" in error_events[0]["message"].lower()
            await client.aclose()


class TestGradeNonStream:
    """Tests for POST /api/grade."""

    async def test_provider_returned_grade_with_empty_quotes_is_saved(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        # Single source of truth: a provider-returned grade with empty quotes is saved.
        file_path = temp_jsonl(sample_data, "test.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result(quotes=[]))

        with patch("backend.main.get_provider", return_value=mock_provider) as get_provider:
            client = await app_no_auth()
            resp = await client.post("/api/grade", json={
                "file_path": str(file_path),
                "sample_ids": [0],
                "metric_name": "test",
                "metric_prompt": "Is this good?",
                "grade_type": "bool",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
                "require_quotes": True,
            })
            assert resp.status_code == 200
            data = resp.json()
            assert data["graded_count"] == 1
            assert len(data["errors"]) == 0
            assert "0" in data["grades"]
            assert mock_provider.grade_sample.await_count == 1
            # Decoupled attempt budget: full documented budget regardless of require_quotes.
            assert get_provider.call_args.kwargs["max_attempts"] == 5
            await client.aclose()

    async def test_accepts_freeform_grades_and_quote_channels(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        mock_provider = MagicMock()
        mock_provider.grade_sample = AsyncMock(return_value=_make_grade_result(
            grade="The sample contains grader reasoning.",
            grade_type="freeform",
            quotes=[Quote(message_index=1, channel="text", start=0, end=5, text="Hello")],
        ))

        with patch("backend.main.get_provider", return_value=mock_provider):
            client = await app_no_auth()
            resp = await client.post("/api/grade", json={
                "file_path": str(file_path),
                "sample_ids": [0],
                "metric_name": "thinking_about_grader",
                "metric_prompt": "Summarize the grader awareness.",
                "grade_type": "freeform",
                "provider": "openai",
                "model": "gpt-4o",
                "api_key": "test-key",
                "require_quotes": True,
            })
            assert resp.status_code == 200
            data = resp.json()
            grade = data["grades"]["0"]
            assert grade["grade"] == "The sample contains grader reasoning."
            assert grade["grade_type"] == "freeform"
            assert grade["quotes"][0]["channel"] == "text"
            await client.aclose()


class TestSaveGraded:
    """Tests for POST /api/save-graded."""

    async def test_creates_viz_dir_and_saves(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        grade_entry = {
            "grade": True,
            "grade_type": "bool",
            "quotes": [],
            "explanation": "good",
            "model": "test",
            "prompt_version": "v1",
            "timestamp": "2026-01-15T10:00:00",
        }
        client = await app_no_auth()
        resp = await client.post("/api/save-graded", json={
            "file_path": str(file_path),
            "grades": {"0": {"helpfulness": grade_entry}},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True

        # Verify viz/ file was created
        viz_path = file_path.parent / "viz" / file_path.name
        assert viz_path.exists()
        await client.aclose()

    async def test_merges_grades_appends(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        grade1 = {
            "grade": True, "grade_type": "bool", "quotes": [],
            "explanation": "first", "model": "m1", "prompt_version": "v1",
            "timestamp": "2026-01-15T10:00:00",
        }
        grade2 = {
            "grade": False, "grade_type": "bool", "quotes": [],
            "explanation": "second", "model": "m2", "prompt_version": "v1",
            "timestamp": "2026-01-15T10:01:00",
        }
        client = await app_no_auth()
        # First save
        await client.post("/api/save-graded", json={
            "file_path": str(file_path),
            "grades": {"0": {"accuracy": grade1}},
        })
        # Second save with same metric — should append
        await client.post("/api/save-graded", json={
            "file_path": str(file_path),
            "grades": {"0": {"accuracy": grade2}},
        })

        # Read viz file and check grades were appended
        viz_path = file_path.parent / "viz" / file_path.name
        with open(viz_path) as f:
            lines = [json.loads(l) for l in f if l.strip()]
        assert len(lines[0]["grades"]["accuracy"]) == 2
        await client.aclose()

    async def test_extra_entry_fields_survive_to_disk(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        """Producer-written extra keys must round-trip losslessly.

        The comments feature's soft-delete tombstones carry a `deletes`
        field the frontend GradeEntry schema knows but this backend model
        does not; a default-config Pydantic model silently strips such
        keys before the merge, which resurrects deleted comments on the
        next load.
        """
        file_path = temp_jsonl(sample_data, "test.jsonl")
        tombstone = {
            "grade": "", "grade_type": "freeform", "quotes": [],
            "explanation": "deleted comment by human:ada from 2026-01-15T10:00:00",
            "model": "human:grace", "prompt_version": "comment-delete-v1",
            "timestamp": "2026-01-15T11:00:00",
            "deletes": {"model": "human:ada", "timestamp": "2026-01-15T10:00:00"},
            "some_future_key": 42,
        }
        client = await app_no_auth()
        resp = await client.post("/api/save-graded", json={
            "file_path": str(file_path),
            "grades": {"0": {"comments": tombstone}},
        })
        assert resp.status_code == 200

        viz_path = file_path.parent / "viz" / file_path.name
        with open(viz_path) as f:
            lines = [json.loads(l) for l in f if l.strip()]
        saved = lines[0]["grades"]["comments"][0]
        assert saved["deletes"] == {"model": "human:ada", "timestamp": "2026-01-15T10:00:00"}
        assert saved["some_future_key"] == 42
        await client.aclose()

    async def test_never_mutates_original(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        original_content = file_path.read_text()

        grade_entry = {
            "grade": 0.9, "grade_type": "float", "quotes": [],
            "explanation": "good", "model": "test", "prompt_version": "v1",
            "timestamp": "2026-01-15T10:00:00",
        }
        client = await app_no_auth()
        await client.post("/api/save-graded", json={
            "file_path": str(file_path),
            "grades": {"0": {"helpfulness": grade_entry}},
        })

        # Original file should be unchanged
        assert file_path.read_text() == original_content
        await client.aclose()

    async def test_out_of_bounds_ids_skipped(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        grade_entry = {
            "grade": True, "grade_type": "bool", "quotes": [],
            "explanation": "test", "model": "test", "prompt_version": "v1",
            "timestamp": "2026-01-15T10:00:00",
        }
        client = await app_no_auth()
        resp = await client.post("/api/save-graded", json={
            "file_path": str(file_path),
            "grades": {"999": {"test": grade_entry}},
        })
        assert resp.status_code == 200
        assert resp.json()["samples_updated"] == 0
        await client.aclose()

    async def test_preserves_freeform_grade_and_quote_channel(self, app_no_auth, temp_jsonl, patch_project_root, sample_data):
        file_path = temp_jsonl(sample_data, "test.jsonl")
        grade_entry = {
            "grade": "The sample explicitly considers grading.",
            "grade_type": "freeform",
            "quotes": [{
                "message_index": 1,
                "channel": "text",
                "start": 0,
                "end": 5,
                "text": "Hello",
            }],
            "explanation": "freeform rationale",
            "model": "model_router:litellm:gpt-4o",
            "prompt_version": "v1",
            "timestamp": "2026-01-15T10:00:00",
        }
        client = await app_no_auth()
        resp = await client.post("/api/save-graded", json={
            "file_path": str(file_path),
            "grades": {"0": {"thinking_about_grader": grade_entry}},
        })
        assert resp.status_code == 200
        assert resp.json()["samples_updated"] == 1

        viz_path = file_path.parent / "viz" / file_path.name
        saved = [json.loads(line) for line in viz_path.read_text().splitlines() if line.strip()]
        stored = saved[0]["grades"]["thinking_about_grader"][0]
        assert stored["grade"] == "The sample explicitly considers grading."
        assert stored["grade_type"] == "freeform"
        assert stored["quotes"][0]["channel"] == "text"
        await client.aclose()
