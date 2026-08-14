"""Tests for the rollout-viz-log skill script (scripts/log_cli_session.py).

The script lives outside this repo (~/.claude/skills/rollout-viz-log) but is
the flagship consumer of viz_writer, so its lossless write path — and the
inline fallback it uses when viz_writer isn't importable — is covered here.
Skipped wholesale on machines without the skill installed.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path.home() / ".claude" / "skills" / "rollout-viz-log" / "scripts" / "log_cli_session.py"

pytestmark = pytest.mark.skipif(not SCRIPT.exists(), reason="rollout-viz-log skill not installed")


# A message exercising every replay-critical field the old script used to
# flatten or drop: content_parts, tool_calls, and an unknown provider field.
ASSISTANT_MESSAGE = {
    "role": "assistant",
    "content": "Final visible text.",
    "content_parts": [
        {"type": "thinking", "thinking": "hidden reasoning", "summary": True},
        {"type": "text", "text": "Final visible text."},
    ],
    "tool_calls": [
        {
            "type": "function",
            "id": "call_abc123",
            "function": {"name": "bash", "arguments": '{"command":"ls"}'},
        }
    ],
    "provider_extra": {"nested": [1, 2]},
}


def _write_state(tmp_path, messages=None):
    state = {
        "targetMessages": messages or [{"role": "user", "content": "hi"}, ASSISTANT_MESSAGE],
        "config": {"targetModel": "test-model", "targetToolFormat": "xml"},
        "evalId": "ae_test",
    }
    path = tmp_path / "state.json"
    path.write_text(json.dumps(state))
    return path


def _load_script(monkeypatch, *, without_viz_writer=False):
    if without_viz_writer:
        # None in sys.modules makes `import viz_writer` raise ImportError,
        # forcing the script's inline fallback writer.
        monkeypatch.setitem(sys.modules, "viz_writer", None)
    name = "log_cli_session_fallback" if without_viz_writer else "log_cli_session"
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    # Register before exec (dataclasses resolves the module's annotations
    # through sys.modules when the script uses `from __future__ import annotations`).
    monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setattr(sys, "dont_write_bytecode", True)  # no __pycache__ in the skill dir
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "_load_env", lambda: None)  # local dests need no creds
    return mod


def _run(mod, monkeypatch, capsys, tmp_path, extra_args=(), messages=None, dest=None):
    dest = dest or tmp_path / "out.jsonl"
    state = _write_state(tmp_path, messages)
    argv = ["log_cli_session.py", "--state", str(state), "--dest", str(dest), *extra_args]
    monkeypatch.setattr(sys, "argv", argv)
    rc = mod.main()
    out = capsys.readouterr().out
    return rc, (json.loads(out) if rc == 0 else out), dest


def _read_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class TestLosslessWrite:
    def test_messages_round_trip_untouched(self, monkeypatch, capsys, tmp_path):
        mod = _load_script(monkeypatch)
        rc, out, dest = _run(mod, monkeypatch, capsys, tmp_path)
        assert rc == 0
        (entry,) = _read_lines(dest)
        assert entry["messages"][0] == {"role": "user", "content": "hi"}
        assert entry["messages"][1] == ASSISTANT_MESSAGE  # content_parts + tool_calls intact

    def test_honest_attributes_only(self, monkeypatch, capsys, tmp_path):
        mod = _load_script(monkeypatch)
        rc, out, dest = _run(mod, monkeypatch, capsys, tmp_path)
        assert rc == 0
        attrs = _read_lines(dest)[0]["attributes"]
        assert attrs["viz_id"]
        for key in ("reward", "step", "sample_index", "validate"):
            assert key not in attrs, f"{key} must not be fabricated"
        assert attrs["rollout_n"] > 0  # honest unique id kept for legacy links
        assert attrs["target_model"] == "test-model"
        assert attrs["eval_id"] == "ae_test"

    def test_prints_canonical_urls(self, monkeypatch, capsys, tmp_path):
        mod = _load_script(monkeypatch)
        rc, out, dest = _run(mod, monkeypatch, capsys, tmp_path)
        assert rc == 0
        assert out["ok"] is True
        assert out["dest"] == str(dest)
        assert out["rollout_viz_url"].endswith("&index=0")
        assert "?file=" in out["file_url"]
        assert out["message_count"] == 2

    def test_redaction_preserves_structure(self, monkeypatch, capsys, tmp_path):
        secret = "sk-" + "a" * 24
        msg = {
            "role": "assistant",
            "content": f"key is {secret}",
            "content_parts": [{"type": "thinking", "thinking": f"use {secret}", "summary": False}],
        }
        mod = _load_script(monkeypatch)
        rc, out, dest = _run(mod, monkeypatch, capsys, tmp_path, messages=[msg])
        assert rc == 0
        (entry,) = _read_lines(dest)
        written = entry["messages"][0]
        assert written["content"] == "key is <redacted-anthropic-key>"
        assert written["content_parts"] == [
            {"type": "thinking", "thinking": "use <redacted-anthropic-key>", "summary": False}
        ]

    def test_create_mode_refuses_existing_dest(self, monkeypatch, capsys, tmp_path):
        mod = _load_script(monkeypatch)
        rc, _, dest = _run(mod, monkeypatch, capsys, tmp_path)
        assert rc == 0
        rc, _, _ = _run(mod, monkeypatch, capsys, tmp_path, dest=dest)
        assert rc == 1

    def test_append_mode_extends(self, monkeypatch, capsys, tmp_path):
        mod = _load_script(monkeypatch)
        _run(mod, monkeypatch, capsys, tmp_path)
        rc, out, dest = _run(
            mod, monkeypatch, capsys, tmp_path, extra_args=("--mode", "append"),
            dest=tmp_path / "out.jsonl",
        )
        assert rc == 0
        assert out["samples_in_file"] == 2
        assert out["rollout_viz_url"].endswith("&index=1")
        assert len(_read_lines(dest)) == 2


class TestFallbackWriter:
    def test_fallback_matches_canonical_behavior(self, monkeypatch, capsys, tmp_path):
        mod = _load_script(monkeypatch, without_viz_writer=True)
        rc, out, dest = _run(mod, monkeypatch, capsys, tmp_path)
        assert rc == 0
        (entry,) = _read_lines(dest)
        assert entry["messages"][1] == ASSISTANT_MESSAGE  # still lossless
        attrs = entry["attributes"]
        assert len(attrs["viz_id"]) == 32
        for key in ("reward", "step", "sample_index"):
            assert key not in attrs, f"{key} must not be fabricated"
        assert entry["timestamp"]
        assert out["rollout_viz_url"].endswith("&index=0")

    def test_fallback_create_refuses_existing_dest(self, monkeypatch, capsys, tmp_path):
        mod = _load_script(monkeypatch, without_viz_writer=True)
        rc, _, dest = _run(mod, monkeypatch, capsys, tmp_path)
        assert rc == 0
        rc, _, _ = _run(mod, monkeypatch, capsys, tmp_path, dest=dest)
        assert rc == 1
