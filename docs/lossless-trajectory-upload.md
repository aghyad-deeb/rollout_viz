# Lossless Rollout Trajectory Upload

This document describes how to write and upload rollout_viz JSONL trajectories so
they can be replayed exactly by downstream tools such as web_chat_vite and
auto_eval.

The short version: do not reduce messages to `{ role, content }`. Preserve the
full universal message shape, the original JSONL row, and provider replay
metadata.

## Goal

A trajectory is lossless when a downstream replay system can reconstruct the
same model-visible conversation state that produced the trajectory.

Lossless replay requires preserving:

- final visible assistant text
- hidden or structured reasoning
- tool calls, tool results, call ids, and tool names
- provider-native replay items such as OpenAI Responses `reasoning` and
  `function_call` output items
- raw source messages and original JSONL rows for audit
- token and prompt-token caches when the producer has them

If any replay-critical field is missing, the artifact should be marked lossy or
rejected by exact-import code. Silent best-effort conversion is the bug.

## Recommended JSONL Row Shape

Each uploaded JSONL line should be one rollout sample:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are ChatGPT."
    },
    {
      "role": "user",
      "content": "Solve the task."
    },
    {
      "role": "assistant",
      "content": "Final visible answer only.",
      "content_parts": [
        { "type": "thinking", "thinking": "real reasoning text" },
        { "type": "text", "text": "Final visible answer only." }
      ],
      "tool_calls": [
        {
          "type": "function",
          "id": "call_abc123",
          "function": {
            "name": "bash",
            "arguments": "{\"command\":\"ls\"}"
          }
        }
      ],
      "openai_response_items": [
        {
          "type": "reasoning",
          "id": "rs_...",
          "content": [{ "type": "text", "text": "real reasoning text" }],
          "encrypted_content": "..."
        },
        {
          "type": "function_call",
          "call_id": "call_abc123",
          "name": "bash",
          "arguments": "{\"command\":\"ls\"}",
          "status": "completed"
        }
      ]
    },
    {
      "role": "tool",
      "content": "file.txt\n",
      "name": "bash",
      "tool_call_id": "call_abc123"
    }
  ],
  "raw_messages": [
    "optional producer-native raw message payloads"
  ],
  "attributes": {
    "sample_index": 0,
    "step": 1,
    "rollout_n": 123456789,
    "reward": 0,
    "data_source": "chat/interactive",
    "experiment_name": "my_experiment",
    "model_id": "provider/model-or-checkpoint",
    "provider": "rl_late",
    "renderer_name": "optional-renderer",
    "target_tool_format": "tinker",
    "validate": false
  },
  "timestamp": "2026-05-14T23:00:00.000Z"
}
```

## Message Invariants

### `content`

`message.content` must be final visible text only.

Do not put hidden reasoning, provider summaries, tool metadata, or raw response
objects in `content`. This field is the most likely field to be replayed as
model-visible text by legacy consumers.

For assistant messages with only tool calls and no final answer, `content` may
be an empty string.

### `content_parts`

Use `content_parts` for structured assistant output.

Common parts:

```json
{ "type": "thinking", "thinking": "reasoning text" }
{ "type": "text", "text": "final visible text" }
{ "type": "text", "channel": "analysis", "text": "harmony analysis" }
{ "type": "text", "channel": "final", "text": "harmony final" }
```

Rules:

- Keep reasoning in `content_parts`, not in `content`.
- Preserve provider or renderer fields such as `channel`.
- If a part is only a provider summary, mark it with `"summary": true`.
- For exact replay of visible-CoT models, prefer real reasoning text over
  summary text.

### `tool_calls` and tool results

Every assistant tool call must have a stable id:

```json
{
  "type": "function",
  "id": "call_abc123",
  "function": {
    "name": "bash",
    "arguments": "{\"command\":\"ls\"}"
  }
}
```

Every matching tool result must carry the same id:

```json
{
  "role": "tool",
  "name": "bash",
  "tool_call_id": "call_abc123",
  "content": "..."
}
```

Rules:

- `tool_calls[].id` is required when any later tool result references it.
- `tool_calls[].function.arguments` should be a JSON string, not an object.
- `tool_call_id` must match an earlier assistant tool call id.
- Preserve `name` on tool result messages.
- Do not invent ids during upload. If ids are missing, the artifact is not exact.

### `openai_response_items`

For `rl_late` / OpenAI Responses trajectories, preserve non-message output
items exactly as received from the provider.

This includes:

- `reasoning` items, especially `encrypted_content`
- `function_call` items
- hosted tool-call items such as `web_search_call` or `code_interpreter_call`
- ids, call ids, status, arguments, and all unknown provider fields

Do not flatten these items into `content`. Downstream Responses replay uses
them as typed input items, not as visible text.

### Raw archival fields

When available, include raw archival data:

```json
{
  "raw_messages": ["producer-native messages"],
  "raw": {
    "source_messages": ["optional"],
    "provider_payloads": ["optional"]
  }
}
```

These fields are not usually replayed directly, but they make exactness
auditable and allow future importers to recover fields older importers missed.

## Exact Prefill v2 Export

rollout_viz's exact copy path should export an envelope rather than a bare
message array:

```json
{
  "schema_version": 2,
  "kind": "exact_prefill",
  "source_app": "rollout_viz",
  "source": {
    "file": "s3://rewardseeker/logs_jsonl/...",
    "rollout_n": 123456789,
    "step": 1,
    "sample_index": 0,
    "model_id": "provider/model-or-checkpoint"
  },
  "messages": [],
  "raw": {
    "source_messages": [],
    "raw_messages": [],
    "jsonl_entry": {}
  },
  "diagnostics": []
}
```

Use this envelope when copying a rollout into auto_eval. The old bare
`[{role, content}]` format is legacy and lossy.

## Upload Location

Use stable S3 keys under the rewardseeker bucket:

```text
s3://rewardseeker/logs_jsonl/chats/<YYYY-MM-DD>/<model_id>/<experiment_name>/<chat_id>.jsonl
s3://rewardseeker/logs_jsonl/online_chats/<YYYY-MM-DD>/<provider__model>/<experiment_name>/<chat_id>.jsonl
s3://rewardseeker/logs_jsonl/evals/<YYYY-MM-DD>/<model_id>/<experiment_name>/<run_id>.jsonl
```

For rollout_viz, any browsable JSONL path is acceptable, but keeping model,
date, and experiment in the path makes links and history easier to reason
about.

Upload with:

```bash
aws s3 cp ./trajectory.jsonl s3://rewardseeker/logs_jsonl/chats/2026-05-14/model/experiment/run.jsonl
```

## Validation Checklist

Before uploading, validate every JSONL row:

- Each line parses as one JSON object.
- `messages` is an array.
- Every message has `role` and string `content`.
- Assistant `content` contains final visible text only.
- Reasoning is preserved in `content_parts` and/or provider replay fields.
- No literal `<think>...</think>` appears in `content` when structured
  reasoning exists, unless the target renderer explicitly expects XML think
  tags as model-visible input.
- Every assistant `tool_calls[].id` is unique within the conversation.
- Every tool result has `tool_call_id`.
- Every tool result `tool_call_id` matches an earlier assistant tool call id.
- Tool call arguments are JSON strings.
- `openai_response_items` is preserved for `rl_late` turns.
- `raw_messages` or `raw.jsonl_entry` is present when the uploader has access
  to the original provider/source payload.
- Export diagnostics are empty before claiming exact replay.

## Common Lossy Patterns

Avoid these patterns:

```json
{ "role": "assistant", "content": "<think>hidden reasoning</think>\nFinal" }
```

Use structured parts instead:

```json
{
  "role": "assistant",
  "content": "Final",
  "content_parts": [
    { "type": "thinking", "thinking": "hidden reasoning" },
    { "type": "text", "text": "Final" }
  ]
}
```

Avoid object tool arguments:

```json
{ "function": { "name": "bash", "arguments": { "command": "ls" } } }
```

Use JSON string arguments:

```json
{ "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" } }
```

Avoid orphan tool results:

```json
{ "role": "tool", "content": "output" }
```

Use threaded tool results:

```json
{ "role": "tool", "name": "bash", "tool_call_id": "call_abc123", "content": "output" }
```

Avoid dropping Responses replay items:

```json
{
  "role": "assistant",
  "content": "Final",
  "content_parts": [{ "type": "thinking", "thinking": "reasoning" }]
}
```

For `rl_late`, also preserve:

```json
{
  "openai_response_items": [
    {
      "type": "reasoning",
      "id": "rs_...",
      "content": [{ "type": "text", "text": "reasoning" }],
      "encrypted_content": "..."
    }
  ]
}
```

## Minimal Python Writer

```python
import json
from datetime import datetime, timezone


def write_jsonl(path: str, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def sample_row(messages: list[dict], *, rollout_n: int, model_id: str, experiment: str) -> dict:
    return {
        "messages": messages,
        "attributes": {
            "sample_index": 0,
            "step": 1,
            "rollout_n": rollout_n,
            "reward": 0,
            "data_source": "chat/interactive",
            "experiment_name": experiment,
            "model_id": model_id,
            "validate": False,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
```

The writer intentionally does not normalize, flatten, or summarize messages.
Exact upload code should preserve the producer's structured message objects as
data, not reinterpret them as display text.
