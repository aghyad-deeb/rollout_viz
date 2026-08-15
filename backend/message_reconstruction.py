"""Display reconstruction of tinker-serialized assistant messages.

Some producers (the tinker_rl training harness's inkling/nemotron replication
runs) log each assistant turn as ONE raw string in the sampler's own token
grammar instead of decomposed reasoning/content/tool_calls:

    <|content_thinking|>THINKING<|end_message|>
    <|message_model|>NAME<|content_invoke_tool_json|>{"name":...,"args":...}<|end_message|>
    <|message_model|><|content_text|>VISIBLE TEXT<|end_message|>
    <|content_model_end_sampling|>

This module decomposes such messages at serving time so rendering, search,
quotes, and LLM-judge prompts all see clean channels. Contract:

- The original string is preserved losslessly in ``raw_content``.
- Input dicts are never mutated; untouched messages keep their identity.
- Anything outside the known grammar is left alone — bail out on the first
  unknown segment rather than guess. Never raises.
- Idempotent: a message already carrying reasoning/tool_calls is skipped, so
  viz/ overlays written after reconstruction don't get double-processed.

Pure module: no imports from backend.main (safe for llm_providers too).
"""
import json
from typing import Any, Dict, List, Optional, Tuple

_THINKING = "<|content_thinking|>"
_MESSAGE_MODEL = "<|message_model|>"
_INVOKE_TOOL = "<|content_invoke_tool_json|>"
_TEXT = "<|content_text|>"
_END_MESSAGE = "<|end_message|>"
_END_SAMPLING = "<|content_model_end_sampling|>"

# Cheap containment probe before any splitting work.
_MARKERS = (_THINKING, _INVOKE_TOOL, _TEXT)


def reconstruct_message(msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Decompose one tinker-serialized assistant message.

    Returns the decomposed copy, or None when the message is not in the
    tinker grammar (wrong role, already decomposed, no markers, or any
    segment that doesn't parse cleanly).
    """
    if msg.get("role") != "assistant":
        return None
    if msg.get("reasoning") or msg.get("tool_calls") or msg.get("content_parts"):
        return None  # already decomposed — never re-process
    content = msg.get("content")
    if not isinstance(content, str) or not any(m in content for m in _MARKERS):
        return None

    thinking_parts: List[str] = []
    text_parts: List[str] = []
    tool_calls: List[Dict[str, Any]] = []

    stripped = content.replace(_END_SAMPLING, "")
    for segment in stripped.split(_END_MESSAGE):
        if segment == "":
            continue
        if segment.startswith(_THINKING):
            thinking_parts.append(segment[len(_THINKING):])
        elif segment.startswith(_MESSAGE_MODEL) or segment.startswith(_TEXT):
            rest = segment[len(_MESSAGE_MODEL):] if segment.startswith(_MESSAGE_MODEL) else segment
            if _INVOKE_TOOL in rest:
                recipient, _, payload = rest.partition(_INVOKE_TOOL)
                try:
                    call = json.loads(payload)
                except (ValueError, TypeError):
                    return None
                if not isinstance(call, dict):
                    return None
                tool_calls.append({
                    "type": "function",
                    "function": {
                        "name": call.get("name") or recipient,
                        # The grammar says "args"; the app's ToolCall says
                        # "arguments". Fall back to the whole payload when
                        # neither key is present.
                        "arguments": call.get("args", call.get("arguments", call)),
                    },
                })
            elif rest.startswith(_TEXT):
                text_parts.append(rest[len(_TEXT):])
            else:
                return None  # unknown segment shape — leave the message alone
        else:
            return None  # unknown marker — leave the message alone

    if not (thinking_parts or text_parts or tool_calls):
        return None

    out = dict(msg)
    out["raw_content"] = content
    out["content"] = "\n\n".join(text_parts)
    if thinking_parts:
        out["reasoning"] = "\n\n".join(thinking_parts)
    if tool_calls:
        out["tool_calls"] = tool_calls
    return out


def reconstruct_messages(messages: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """Reconstruct every tinker-serialized message in a conversation.

    Returns (messages, count). When nothing matches, the input list itself is
    returned (identity preserved — the common case stays allocation-free).
    """
    rebuilt: Optional[List[Dict[str, Any]]] = None
    count = 0
    for i, msg in enumerate(messages):
        try:
            out = reconstruct_message(msg)
        except Exception:
            out = None  # reconstruction must never break loading
        if out is not None:
            if rebuilt is None:
                rebuilt = list(messages)
            rebuilt[i] = out
            count += 1
    return (rebuilt if rebuilt is not None else messages), count


def reconstruction_note(count: int) -> str:
    """The sample-level diagnostics line surfaced by the amber diag pill."""
    return (
        f"display reconstruction from tinker token serialization "
        f"({count} assistant message{'s' if count != 1 else ''} decomposed; "
        f"originals kept in raw_content)"
    )
