"""Display reconstruction of tinker-serialized assistant messages.

The tinker_rl training harness logs assistant turns as ONE raw string in its
own token grammar instead of decomposed reasoning/content/tool_calls:

    <|content_thinking|>THINKING<|end_message|>
    <|message_model|>NAME<|content_invoke_tool_json|>{"name":...,"args":...}<|end_message|>
    <|message_model|><|content_text|>VISIBLE TEXT<|end_message|>
    <|content_model_end_sampling|>

reconstruct_messages() decomposes such messages for display/search/grading,
preserving the original string in raw_content. Unknown grammar leaves the
message untouched — never guess, never raise.
"""
import json

import pytest

from backend.message_reconstruction import (
    reconstruct_message,
    reconstruct_messages,
)


# Verbatim shapes from s3://rewardseeker/.../inkling_replication/.../step_14.jsonl
TOOL_TURN = (
    "<|content_thinking|>We need find problem.txt. Use bash.<|end_message|>"
    "<|message_model|>bash<|content_invoke_tool_json|>"
    '{"name":"bash","args":{"command":"find . -name \'problem.txt\' 2>/dev/null"}}'
    "<|end_message|><|content_model_end_sampling|>"
)
FINAL_TURN = (
    "<|content_thinking|>Works. Confirm file written.<|end_message|>"
    "<|message_model|><|content_text|>Solution written to `code.py`.<|end_message|>"
    "<|content_model_end_sampling|>"
)


class TestReconstructMessage:
    def test_tool_call_turn(self):
        out = reconstruct_message({"role": "assistant", "content": TOOL_TURN})
        assert out is not None
        assert out["reasoning"] == "We need find problem.txt. Use bash."
        assert out["content"] == ""
        assert len(out["tool_calls"]) == 1
        tc = out["tool_calls"][0]
        assert tc["type"] == "function"
        assert tc["function"]["name"] == "bash"
        assert tc["function"]["arguments"] == {"command": "find . -name 'problem.txt' 2>/dev/null"}
        # The original serialization is preserved losslessly.
        assert out["raw_content"] == TOOL_TURN

    def test_final_text_turn(self):
        out = reconstruct_message({"role": "assistant", "content": FINAL_TURN})
        assert out is not None
        assert out["reasoning"] == "Works. Confirm file written."
        assert out["content"] == "Solution written to `code.py`."
        assert "tool_calls" not in out or not out["tool_calls"]

    def test_bare_content_text_segment(self):
        # Tolerate a text segment without the <|message_model|> prefix.
        out = reconstruct_message({
            "role": "assistant",
            "content": "<|content_text|>plain answer<|end_message|><|content_model_end_sampling|>",
        })
        assert out is not None
        assert out["content"] == "plain answer"

    def test_multiple_thinking_segments_join(self):
        content = (
            "<|content_thinking|>first<|end_message|>"
            "<|content_thinking|>second<|end_message|>"
            "<|message_model|><|content_text|>done<|end_message|>"
            "<|content_model_end_sampling|>"
        )
        out = reconstruct_message({"role": "assistant", "content": content})
        assert out["reasoning"] == "first\n\nsecond"

    def test_non_token_message_untouched(self):
        msg = {"role": "assistant", "content": "just a normal answer"}
        assert reconstruct_message(msg) is None

    def test_non_assistant_roles_untouched(self):
        msg = {"role": "tool", "content": TOOL_TURN, "name": "bash"}
        assert reconstruct_message(msg) is None

    def test_already_decomposed_message_untouched(self):
        # Idempotency: a message that already carries reasoning or tool_calls
        # (e.g. served from a viz/ overlay written after reconstruction) is
        # never re-processed.
        msg = {"role": "assistant", "content": TOOL_TURN, "reasoning": "already there"}
        assert reconstruct_message(msg) is None

    def test_unknown_segment_marker_bails_out(self):
        content = "<|content_mystery|>???<|end_message|><|content_thinking|>hm<|end_message|>"
        assert reconstruct_message({"role": "assistant", "content": content}) is None

    def test_malformed_tool_json_bails_out(self):
        content = (
            "<|message_model|>bash<|content_invoke_tool_json|>{not json"
            "<|end_message|><|content_model_end_sampling|>"
        )
        assert reconstruct_message({"role": "assistant", "content": content}) is None

    def test_non_string_content_untouched(self):
        assert reconstruct_message({"role": "assistant", "content": None}) is None
        assert reconstruct_message({"role": "assistant", "content": ["parts"]}) is None

    def test_original_dict_not_mutated(self):
        msg = {"role": "assistant", "content": TOOL_TURN}
        reconstruct_message(msg)
        assert msg == {"role": "assistant", "content": TOOL_TURN}


class TestReconstructMessages:
    def test_mixed_conversation(self):
        messages = [
            {"role": "system", "content": "be helpful"},
            {"role": "user", "content": "solve it"},
            {"role": "assistant", "content": TOOL_TURN},
            {"role": "tool", "content": "./problem.txt\n", "name": "bash"},
            {"role": "assistant", "content": FINAL_TURN},
        ]
        out, n = reconstruct_messages(messages)
        assert n == 2
        assert out[0] is messages[0]  # untouched entries keep identity
        assert out[2]["reasoning"] == "We need find problem.txt. Use bash."
        assert out[4]["content"] == "Solution written to `code.py`."

    def test_no_token_messages_returns_same_list(self):
        messages = [{"role": "user", "content": "hi"}]
        out, n = reconstruct_messages(messages)
        assert n == 0
        assert out is messages  # identity preserved — cheap for the common case


class TestServedThroughApi:
    """The batch endpoint serves reconstructed messages with a diagnostics note."""

    async def test_samples_endpoint_reconstructs(self, app_no_auth, temp_jsonl, patch_project_root):
        rows = [{
            "messages": [
                {"role": "user", "content": "solve it"},
                {"role": "assistant", "content": TOOL_TURN},
            ],
            "attributes": {"sample_index": 0, "rollout_n": 1},
            "timestamp": "2026-08-14T23:00:00",
        }]
        file_path = temp_jsonl(rows, "tinker.jsonl")
        client = await app_no_auth()
        resp = await client.get(f"/api/samples?file={file_path}")
        assert resp.status_code == 200
        sample = resp.json()["samples"][0]
        asst = sample["messages"][1]
        assert asst["reasoning"] == "We need find problem.txt. Use bash."
        assert asst["tool_calls"][0]["function"]["name"] == "bash"
        assert asst["raw_content"] == TOOL_TURN
        assert any("reconstruct" in d.lower() for d in (sample.get("diagnostics") or []))
        # The archival copy in raw_jsonl_entry stays the original serialization.
        raw_asst = sample["raw_jsonl_entry"]["messages"][1]
        assert raw_asst["content"] == TOOL_TURN
        assert "reasoning" not in raw_asst
        await client.aclose()
