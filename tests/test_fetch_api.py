"""Tests for GET /api/rollout — the canonical single-rollout fetch API."""

import json

import pytest


def _sample(content, rollout_n, step=1, reward=0.5, grades=None, extra_attrs=None):
    attrs = {"rollout_n": rollout_n, "step": step, "reward": reward,
             "experiment_name": "exp_x", "validate": False}
    if extra_attrs:
        attrs.update(extra_attrs)
    entry = {
        "messages": [
            {"role": "user", "content": f"Q for {rollout_n}"},
            {"role": "assistant", "content": content},
        ],
        "attributes": attrs,
        "timestamp": "2026-07-01T10:00:00",
    }
    if grades:
        entry["grades"] = grades
    return entry


def _write_file(tmp_path, name, entries):
    p = tmp_path / name
    with open(p, "w") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")
    return p


@pytest.fixture
def rollout_file(patch_project_root):
    entries = [
        _sample("answer zero", rollout_n=100, step=1),
        _sample("answer one", rollout_n=200, step=1),
        _sample("answer two", rollout_n=200, step=2),  # same rollout_n, later step
    ]
    _write_file(patch_project_root, "fetch_test.jsonl", entries)
    return "fetch_test.jsonl"


class TestFetchByIndex:
    async def test_index_returns_exact_sample(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": rollout_file, "index": 1})
        assert resp.status_code == 200
        body = resp.json()
        assert body["index"] == 1
        assert body["total_in_file"] == 3
        assert body["experiment_name"] == "exp_x"
        assert body["sample"]["messages"][1]["content"] == "answer one"
        # validate → is_validate rename applied (canonical form, not raw)
        assert body["sample"]["attributes"]["is_validate"] is False
        assert "validate" not in body["sample"]["attributes"]
        # raw_jsonl_entry stripped — the sample IS the raw entry
        assert "raw_jsonl_entry" not in body["sample"]
        await client.aclose()

    async def test_index_out_of_range_404(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": rollout_file, "index": 99})
        assert resp.status_code == 404
        assert "out of range" in resp.json()["detail"]
        await client.aclose()

    async def test_index_wins_over_rollout(self, app_no_auth, rollout_file):
        """Mirrors the frontend: index is authoritative, rollout is fallback."""
        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"file": rollout_file, "index": 0, "rollout": 200}
        )
        assert resp.status_code == 200
        assert resp.json()["index"] == 0
        await client.aclose()


class TestFetchByRollout:
    async def test_rollout_match(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": rollout_file, "rollout": 100})
        assert resp.status_code == 200
        assert resp.json()["index"] == 0
        await client.aclose()

    async def test_ambiguous_rollout_returns_first(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": rollout_file, "rollout": 200})
        assert resp.status_code == 200
        assert resp.json()["index"] == 1
        await client.aclose()

    async def test_step_disambiguates(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"file": rollout_file, "rollout": 200, "step": 2}
        )
        assert resp.status_code == 200
        assert resp.json()["index"] == 2
        await client.aclose()

    async def test_no_match_404(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": rollout_file, "rollout": 999})
        assert resp.status_code == 404
        await client.aclose()


class TestFetchByUrl:
    async def test_full_viz_link(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        link = f"http://localhost:3000/?file={rollout_file}&index=2"
        resp = await client.get("/api/rollout", params={"url": link})
        assert resp.status_code == 200
        assert resp.json()["index"] == 2
        await client.aclose()

    async def test_link_with_rollout_param(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        link = f"https://viz.example.com/?file={rollout_file}&rollout=100&highlight=xyz"
        resp = await client.get("/api/rollout", params={"url": link})
        assert resp.status_code == 200
        assert resp.json()["index"] == 0
        await client.aclose()

    async def test_file_level_link_rejected(self, app_no_auth, rollout_file):
        """No consumer should 'accidentally' process a whole file."""
        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"url": f"http://localhost:3000/?file={rollout_file}"}
        )
        assert resp.status_code == 400
        assert "/api/samples" in resp.json()["detail"]
        await client.aclose()

    async def test_share_link_rejected(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"url": "http://localhost:3000/?share=abc123"}
        )
        assert resp.status_code == 400
        await client.aclose()

    async def test_url_and_file_together_rejected(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout",
            params={"url": f"http://x/?file={rollout_file}&index=0", "file": rollout_file},
        )
        assert resp.status_code == 400
        await client.aclose()


class TestVizOverlay:
    async def test_grades_resolved_from_viz_overlay(self, app_no_auth, patch_project_root):
        """The graded viz/ sibling wins over the raw file — the historical
        divergence bug in consumers' hand-rolled fetchers."""
        raw = [_sample("raw answer", rollout_n=7)]
        graded_entry = _sample(
            "raw answer", rollout_n=7,
            grades={"hack": [{"grade": True, "quotes": [], "explanation": "clearly hacked",
                              "model": "gpt-4o", "timestamp": "2026-07-02T00:00:00"}]},
        )
        _write_file(patch_project_root, "overlay_test.jsonl", raw)
        viz_dir = patch_project_root / "viz"
        viz_dir.mkdir()
        _write_file(viz_dir, "overlay_test.jsonl", [graded_entry])

        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": "overlay_test.jsonl", "index": 0})
        assert resp.status_code == 200
        body = resp.json()
        assert body["has_grades"] is True
        assert body["sample"]["grades"]["hack"][0]["grade"] is True
        await client.aclose()


class TestErrors:
    async def test_missing_file_404(self, app_no_auth, patch_project_root):
        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": "nope.jsonl", "index": 0})
        assert resp.status_code == 404
        await client.aclose()

    async def test_no_selector_400(self, app_no_auth, rollout_file):
        client = await app_no_auth()
        resp = await client.get("/api/rollout", params={"file": rollout_file})
        assert resp.status_code == 400
        await client.aclose()

    async def test_requires_auth(self, app_with_auth, rollout_file):
        client = await app_with_auth()
        resp = await client.get("/api/rollout", params={"file": rollout_file, "index": 0})
        assert resp.status_code == 401
        await client.aclose()

    async def test_bearer_token_works(self, app_with_auth, rollout_file, monkeypatch):
        import backend.main as main_module
        monkeypatch.setattr(main_module, "VIZ_API_TOKEN", "tok")
        client = await app_with_auth()
        resp = await client.get(
            "/api/rollout", params={"file": rollout_file, "index": 0},
            headers={"Authorization": "Bearer tok"},
        )
        assert resp.status_code == 200
        await client.aclose()


class TestPlaintext:
    async def test_plaintext_shape(self, app_no_auth, patch_project_root):
        grades = {"hack": [{"grade": True, "quotes": [], "explanation": "e" * 600,
                            "model": "gpt-4o", "timestamp": "t"}]}
        entries = [_sample("short answer", rollout_n=5, grades=grades)]
        _write_file(patch_project_root, "plain.jsonl", entries)

        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"file": "plain.jsonl", "index": 0, "format": "plaintext"}
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/plain")
        text = resp.text
        assert "--- [0] user ---" in text
        assert "--- [1] assistant ---" in text
        assert "short answer" in text
        assert "=== Grades (latest per metric) ===" in text
        assert "hack: True (gpt-4o)" in text
        # explanation capped at 500 chars + ellipsis
        assert "e" * 500 + "…" in text
        assert "e" * 501 not in text
        await client.aclose()

    async def test_plaintext_truncates_long_messages_middle_out(self, app_no_auth, patch_project_root):
        head = "H" * 4000
        tail = "T" * 4000
        entries = [_sample(head + tail, rollout_n=1)]
        _write_file(patch_project_root, "long.jsonl", entries)

        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"file": "long.jsonl", "index": 0, "format": "plaintext"}
        )
        text = resp.text
        assert "chars elided" in text
        assert "H" * 3500 in text  # head kept
        assert "T" * 2000 in text  # tail kept
        assert head + tail not in text
        await client.aclose()

    async def test_plaintext_renders_reasoning_and_tool_calls(self, app_no_auth, patch_project_root):
        entry = {
            "messages": [
                {"role": "assistant",
                 "content": "",
                 "content_parts": [
                     {"type": "reasoning", "text": "thinking about it"},
                     {"type": "text", "text": "final text"},
                 ],
                 "tool_calls": [{"function": {"name": "bash", "arguments": "{\"cmd\": \"ls\"}"}}]},
            ],
            "attributes": {"rollout_n": 1},
            "timestamp": "t",
        }
        _write_file(patch_project_root, "parts.jsonl", [entry])

        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"file": "parts.jsonl", "index": 0, "format": "plaintext"}
        )
        text = resp.text
        assert "[reasoning]\nthinking about it" in text
        assert "final text" in text
        assert "[tool_call] bash(" in text
        await client.aclose()

    async def test_unknown_format_rejected(self, app_no_auth, rollout_file):
        """There is exactly one plaintext format — no md=, no max_chars=."""
        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"file": rollout_file, "index": 0, "format": "markdown"}
        )
        assert resp.status_code == 422
        await client.aclose()


class TestPlaintextCrashSafety:
    """Malformed lines must degrade gracefully in plaintext — never a 500
    where the JSON format succeeds."""

    async def test_malformed_tool_calls_and_parts(self, app_no_auth, patch_project_root):
        entry = {
            "messages": [
                {"role": "assistant", "content": "ok",
                 "tool_calls": [{"function": None}, {"function": "bash"}, None, "junk"]},
                {"role": "assistant", "content": "",
                 "content_parts": [{"type": "text", "text": 123}, "junk", None]},
                {"role": "assistant", "content": [{"text": 456}, 789]},
                {"role": "assistant", "content": None},
            ],
            "attributes": {"rollout_n": 1},
            "timestamp": "",
        }
        (patch_project_root / "mal.jsonl").write_text(__import__("json").dumps(entry) + "\n")

        client = await app_no_auth()
        for fmt in ("plaintext", "json"):
            resp = await client.get(
                "/api/rollout", params={"file": "mal.jsonl", "index": 0, "format": fmt}
            )
            assert resp.status_code == 200, f"{fmt} returned {resp.status_code}"
        await client.aclose()

    async def test_malformed_grades(self, app_no_auth, patch_project_root):
        entry = {
            "messages": [{"role": "user", "content": "hi"}],
            "attributes": {"rollout_n": 1},
            "grades": {"m1": [None], "m2": "oops", "m3": [{"grade": True, "explanation": 5}]},
            "timestamp": "",
        }
        (patch_project_root / "malg.jsonl").write_text(__import__("json").dumps(entry) + "\n")

        client = await app_no_auth()
        resp = await client.get(
            "/api/rollout", params={"file": "malg.jsonl", "index": 0, "format": "plaintext"}
        )
        assert resp.status_code == 200
        assert "m3: True" in resp.text  # well-formed entry still rendered
        await client.aclose()
