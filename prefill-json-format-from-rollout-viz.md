# Prefill JSON format — copying from `rollout_viz`

This document specifies the Exact Prefill v2 JSON envelope `auto_eval`
accepts when copying from `rollout_viz`.
It covers every supported combination of:

- **target provider**: `tinker` (default) vs `rl_late`
- **target tool format** (tinker only): `xml` vs `tinker` (harmony)
- **with / without tool calls**
- **with / without reasoning round-trip**

`rollout_viz` is a multi-source viewer — it parses JSONL produced by
auto_eval, web_chat_vite, raw verl rollouts, and other consumers.
What's in the JSONL on disk depends on who wrote it. This doc
documents what rollout_viz exposes, not what other systems put in
their files.

Source files referenced:
- rollout_viz Message type: `frontend/src/types/index.ts:1-21`
- rollout_viz copy button: `frontend/src/components/RightPanel/NavigationBar.tsx:87-91`
- rollout_viz reasoning parser: `frontend/src/utils/parseContent.ts:141-309`
- rollout_viz fixtures: `tests/fixtures/small_sample.jsonl`, `tests/fixtures/graded_sample.jsonl`
- auto_eval prefill type: `src/lib/types.ts` `PrefilledTargetMessage`
- auto_eval validation: `src/server/routers/evalDef.ts`

---

## 1. The two ways to extract data from `rollout_viz`

### 1.1 — "Copy Conversation" button (Exact Prefill v2)

Located on the navigation bar. Produces:

```ts
{
  schema_version: 2,
  kind: "exact_prefill",
  source_app: "rollout_viz",
  source: { /* file, rollout, step, sample metadata */ },
  messages: [ /* final text + structured replay fields */ ],
  raw: { source_messages, raw_messages, jsonl_entry },
  diagnostics: []
}
```

`messages[].content` is final visible text only. Reasoning, tool calls,
tool results, Responses replay items, raw provider payloads, token caches,
and the original JSONL row are preserved in structured fields. Export-time
diagnostics flag replay-critical gaps such as missing tool-call ids.

Legacy bare message arrays are still accepted by auto_eval as a lossy path,
but they are not exact replay artifacts.

### 1.2 — Raw JSONL row (full fidelity, depends on producer)

A `rollout_viz` JSONL file contains one JSON object per line — the
"sample". The parsed shape (rollout_viz `Sample` type, `types/index.ts:60-67`):

```json
{
  "messages": [ /* Message[] */ ],
  "attributes": { /* SampleAttributes */ },
  "timestamp": "2026-01-15T10:00:00",
  "grades": { /* SampleGrades — optional */ },
  "raw_messages": [ /* optional, producer-specific */ ]
}
```

Auto_eval's Exact Prefill v2 parser imports `.messages` for replay and
preserves raw archival fields for audit/storage. Legacy bare arrays still
import only messages and are explicitly lossy.

This path preserves whatever the JSONL producer wrote — if auto_eval
or web_chat_vite wrote the row, all needed fields are present. If a
raw verl rollout wrote it, fields may be missing (see §4).

---

## 2. Per-message field reference

`rollout_viz`'s `Message` type (`types/index.ts:15-21`):

```ts
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string;
  content_parts?: ContentPart[];
  tool_calls?: ToolCall[];
}
```

Mapping each field to auto_eval's `PrefilledTargetMessage`:

| rollout_viz field | auto_eval field | Notes |
|---|---|---|
| `role` | `role` | direct |
| `content` | `content` | direct; max 1,000,000 chars on auto_eval side |
| `reasoning` (string) | **NOT MAPPED** | rollout_viz's Anthropic-style reasoning string. Anthropic models aren't supported as auto_eval targets, so this is dropped. |
| `content_parts[]` | `content_parts[]` | direct (only meaningful for `provider: 'tinker'` harmony) |
| `tool_calls[]` | `tool_calls[]` | **shape difference — see §3** |

`rollout_viz` does **not** define `tool_call_id`, `name`, or
`openai_response_items` on its `Message` type. If the underlying JSONL
contains these fields (because the producer wrote them), they're
preserved in the JSON object even though rollout_viz's TypeScript type
doesn't declare them. Auto_eval reads them on import.

### Auto_eval-only fields (preserved when present in raw JSONL)

If the JSONL was produced by auto_eval or web_chat_vite, these extra
fields are in the JSON even though rollout_viz's type doesn't declare
them:

| Field | Purpose | auto_eval treatment |
|---|---|---|
| `tool_call_id` | required when `role: 'tool'` for threading | direct copy; required by validator |
| `name` | tool message — name of originating tool | direct copy |
| `openai_response_items` | rl_late reasoning round-trip | direct copy |
| `tokens` / `prompt_tokens` | tinker_service tokenization cache | preserved in Exact Prefill v2 |
| `prefilled` | UI badge marker | dropped on import (re-applied at run time) |

---

## 3. `tool_calls[]` shape difference (important)

The shapes are **not identical** between rollout_viz and auto_eval.

### rollout_viz `ToolCall` type (`types/index.ts:1-7`):

```ts
export interface ToolCall {
  type: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;  // either object or string
  };
}
```

Notes:
- **No `id` field declared** — but the underlying JSONL may have one if
  the producer wrote it.
- `arguments` can be either a **JSON object** OR a **JSON string**.

### auto_eval `PrefilledTargetMessage.tool_calls[]`:

```ts
{
  type: 'function';                  // strict literal
  id: string;                        // REQUIRED, alphanumeric+underscore+hyphen, 1-256 chars
  function: { name: string; arguments: string };  // arguments must be JSON STRING
}
```

### Translation rules at import

If the rollout_viz tool_call has:
- **No `id`**: auto_eval's threading validator will reject any tool
  result that tries to reference it. The prefill author must add an
  `id` matching `/^[a-zA-Z0-9_-]+$/`.
- **`arguments` as object**: auto_eval requires a string. Convert with
  `JSON.stringify(arguments)`.
- **`type: 'web_search_call'` etc.**: auto_eval only accepts
  `type: 'function'` in the structured `tool_calls` field.
  Hosted-tool calls live in `openai_response_items` instead (rl_late
  only).

---

## 4. Reasoning fields — three patterns rollout_viz parses

`rollout_viz`'s `parseContent.ts:141-309` recognizes four distinct
reasoning patterns. Each maps differently to auto_eval prefill:

| rollout_viz pattern | Where it lives | Auto_eval prefill mapping |
|---|---|---|
| **Anthropic-style** | top-level `message.reasoning: string` | **dropped** — Anthropic isn't an auto_eval target |
| **Harmony channels** | `content_parts: [{type:'thinking',thinking:'...'}, {type:'text',text:'...'}]` | direct copy → `content_parts` (use with `provider: 'tinker'` harmony) |
| **Content-embedded** | `<think>...</think>` tags inside `content` string | leave as-is in `content`; tinker xml mode reads it directly |
| **ChatML / Kimi inline** | `<|im_middle|>` and `<|tool_calls_section_begin|>` markers in `content` | leave as-is in `content`; tinker harmony renderer handles markers natively |

`openai_response_items` for rl_late reasoning is **not** a documented
rollout_viz pattern — but if the JSONL was produced by auto_eval (which
writes the field on assistant messages from rl_late runs), it's
preserved in the raw JSON and auto_eval reads it on import.

---

## 5. The 6 supported provider × tool × reasoning combinations

Below: how each combination looks as a rollout_viz JSONL row's
`messages` array, and what auto_eval extracts.

### 5.1 — `provider: 'tinker'`, format `'xml'`, no tools, no reasoning

The simplest case. Plain text. "Copy Conversation" works for this
case — the lossy strip preserves everything that matters.

```json
[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user", "content": "What's 2 + 2?" },
  { "role": "assistant", "content": "4" }
]
```

### 5.2 — `provider: 'tinker'`, format `'xml'`, with tools, no reasoning

XML-mode bash tools. The bash command lives as raw `<bash>...</bash>`
text inside the assistant's `content`. The tool result is a `role:'tool'`
message.

For threading to validate in auto_eval, the assistant must have a
`tool_calls[]` entry whose `id` matches the tool result's
`tool_call_id`. Auto_eval's live xml execution (`orchestrator.ts:1213`)
populates this synthetic `tool_calls[]` automatically; if the JSONL
was written by an auto_eval run, both halves are present.

```json
[
  { "role": "system", "content": "You are a helpful assistant with bash access." },
  { "role": "user", "content": "List the files in /tmp." },
  {
    "role": "assistant",
    "content": "I'll list /tmp.\n<bash>ls /tmp</bash>",
    "tool_calls": [
      {
        "type": "function",
        "id": "call_xml_01",
        "function": { "name": "bash", "arguments": "{\"command\":\"ls /tmp\"}" }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_xml_01",
    "name": "bash",
    "content": "file1.txt\nfile2.txt\n"
  },
  { "role": "assistant", "content": "Two files: file1.txt and file2.txt." }
]
```

### 5.3 — `provider: 'tinker'`, format `'tinker'` (harmony), no tools, with reasoning

Harmony channels. Reasoning lives in `content_parts`. `content` carries
the visible final text.

```json
[
  { "role": "system", "content": "You are a careful reasoner." },
  { "role": "user", "content": "What's 17 × 24?" },
  {
    "role": "assistant",
    "content": "408.",
    "content_parts": [
      {
        "type": "thinking",
        "thinking": "17 × 20 = 340. 17 × 4 = 68. 340 + 68 = 408."
      },
      {
        "type": "text",
        "text": "408."
      }
    ]
  }
]
```

Note: rollout_viz's `ContentPart` type (`types/index.ts:9-13`) is:
```ts
{ type: 'thinking' | 'text'; thinking?: string; text?: string }
```
It does NOT declare a `channel` field, but the underlying JSONL may
include one if the producer wrote it (auto_eval / web_chat_vite both
write `channel: 'analysis' | 'final'`). Auto_eval reads `channel` if
present.

### 5.4 — `provider: 'tinker'`, format `'tinker'` (harmony), with tools, with reasoning

Harmony with structured tools. Both `content_parts` and `tool_calls`
populated on the same assistant message.

```json
[
  { "role": "system", "content": "You are a helpful assistant with bash access." },
  { "role": "user", "content": "List /tmp." },
  {
    "role": "assistant",
    "content": "Running ls now.",
    "content_parts": [
      { "type": "thinking", "thinking": "User wants directory listing." },
      { "type": "text", "text": "Running ls now." }
    ],
    "tool_calls": [
      {
        "type": "function",
        "id": "call_h_01",
        "function": { "name": "bash", "arguments": "{\"command\":\"ls /tmp\"}" }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_h_01",
    "name": "bash",
    "content": "file1.txt\nfile2.txt\n"
  },
  {
    "role": "assistant",
    "content": "Two files in /tmp: file1.txt, file2.txt.",
    "content_parts": [
      { "type": "thinking", "thinking": "Got it. Summarizing." },
      { "type": "text", "text": "Two files in /tmp: file1.txt, file2.txt." }
    ]
  }
]
```

### 5.5 — `provider: 'rl_late'`, no tools, with reasoning

`rl_late` reasoning is preserved as opaque output items in
`openai_response_items`. `rollout_viz`'s `Message` type doesn't
declare this field, but the underlying JSONL preserves it if auto_eval
wrote the row.

```json
[
  { "role": "system", "content": "You are a careful reasoner." },
  { "role": "user", "content": "What's 17 × 24?" },
  {
    "role": "assistant",
    "content": "408.",
    "openai_response_items": [
      {
        "type": "reasoning",
        "id": "rs_01",
        "encrypted_content": "<opaque base64 from prior /step response>",
        "summary": [
          { "type": "summary_text", "text": "Computing 17 * 24 step by step." }
        ]
      }
    ]
  }
]
```

`encrypted_content` is **opaque** — it can only be obtained from a
real model run. Hand-authoring is not possible. If the rollout_viz
JSONL was produced by an auto_eval rl_late run, the field is preserved
verbatim. If it was produced by another system that doesn't run
rl_late, the field will be absent.

### 5.6 — `provider: 'rl_late'`, with tools, with reasoning

`openai_response_items` mixes `reasoning` and `function_call` items in
emission order. The structured `tool_calls` field on the assistant
message is also populated — both must agree on `call_id`.

```json
[
  { "role": "system", "content": "You are a helpful assistant with bash access." },
  { "role": "user", "content": "List /tmp." },
  {
    "role": "assistant",
    "content": "Running ls.",
    "tool_calls": [
      {
        "type": "function",
        "id": "call_rl_01",
        "function": { "name": "bash", "arguments": "{\"command\":\"ls /tmp\"}" }
      }
    ],
    "openai_response_items": [
      {
        "type": "reasoning",
        "id": "rs_01",
        "encrypted_content": "<opaque>",
        "summary": [{ "type": "summary_text", "text": "User wants /tmp listing" }]
      },
      {
        "type": "function_call",
        "id": "fc_01",
        "call_id": "call_rl_01",
        "name": "bash",
        "arguments": "{\"command\":\"ls /tmp\"}"
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_rl_01",
    "name": "bash",
    "content": "file1.txt\nfile2.txt\n"
  },
  {
    "role": "assistant",
    "content": "Two files in /tmp: file1.txt, file2.txt.",
    "openai_response_items": [
      {
        "type": "reasoning",
        "id": "rs_02",
        "encrypted_content": "<opaque>",
        "summary": [{ "type": "summary_text", "text": "Summarizing for user." }]
      }
    ]
  }
]
```

The `function_call` item's `call_id` must equal `tool_calls[].id` on
the same assistant message. Auto_eval's threading validator only
checks `tool_calls[].id`; tinker_service's
`rl_late_provider.py:build_responses_input` matches `function_call`
items to `tool_calls` and to subsequent tool results.

---

## 6. Threading rules (auto_eval-side validator)

Identical to the web_chat_vite path. Enforced by
`evalDef.ts:validatePrefilledTargetMessages`:

1. Every `role: 'tool'` message must have a `tool_call_id`.
2. `tool_call_id` must match an `id` in a preceding
   `assistant.tool_calls[]`.
3. No tool_call `id` may appear in two different assistant messages.
4. No tool_call `id` may be resolved by more than one tool message.
5. If `name` is present on a tool message, it must equal the
   originating `function.name`.

JSONL rows produced by auto_eval and web_chat_vite naturally satisfy
these rules. JSONL rows from other producers may not.

---

## 7. Variable expansion

Auto_eval resolves `{{variable_name}}` placeholders at run time
against the bound `ModelConfig.variables`. Resolution applies to:

- `content` (every message)
- `tool_calls[].function.arguments` (assistant messages)

It does **not** apply to `tool_calls[].id`, `tool_call_id`, `name`,
`openai_response_items`, or `content_parts`.

Rollout_viz preserves `{{var}}` placeholders verbatim if they're in
the JSONL — they pass through the parser unchanged.

---

## 8. Size limits (auto_eval-side)

- Total messages: max 200 per def
- Per-message `content`: max 1,000,000 chars
- `tool_calls[].function.arguments` must parse as JSON
- `tool_calls[]` minimum length 1 (no empty arrays — omit the field)
- Empty top-level array `[]` means "explicitly cleared"; gets
  normalized to `undefined` for storage

---

## 9. Compatibility verdict by combination

| Combo | Copy Conversation button | Raw JSONL row |
|-------|---|---|
| 5.1 tinker xml, no tools, no reasoning | ✅ direct paste | ✅ direct paste |
| 5.2 tinker xml, with tools | ⚠️ lossy — tool data stripped | ✅ if producer wrote `tool_calls[].id` (auto_eval, web_chat_vite) |
| 5.3 tinker harmony, no tools, with reasoning | ⚠️ lossy — `content_parts` stripped | ✅ direct paste |
| 5.4 tinker harmony, with tools, with reasoning | ⚠️ lossy — both stripped | ✅ if producer wrote `tool_calls[].id` |
| 5.5 rl_late, no tools, with reasoning | ⚠️ lossy — `openai_response_items` stripped | ✅ if producer wrote `openai_response_items` (auto_eval rl_late, web_chat_vite rl_late) |
| 5.6 rl_late, with tools, with reasoning | ⚠️ lossy — both stripped | ✅ if producer wrote both fields |

For any combination beyond plain text (5.1), the "Copy Conversation"
button output is insufficient for prefill. Use the raw JSONL row,
either by downloading the file from S3 and copying the row, or by
inspecting the JSONL file directly.

When the raw JSONL is from a producer other than auto_eval or
web_chat_vite, fields may be missing (especially `tool_calls[].id`
and `openai_response_items`). Auto_eval's threading validator will
reject incomplete tool flows with a specific error message
identifying which message is malformed.
