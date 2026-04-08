# Reasoning / thinking display vs web_chat JSONL

## Current behavior (fixed)

All assistant messages are normalized through a single `normalizeAssistantMessage()` helper in `parseContent.ts`. This function is used by **rendering** (`MessageCard`), **search/filtering** (`LeftPanel`), and **highlight occurrence counting** (`ChatView`).

### Precedence

1. **`message.content_parts`** — structured `{ type: thinking | text, … }` parts from the sidecar. When present, these are used directly for reasoning and main text.
2. **`message.content`** — raw string, parsed by `parseContent()` which handles:
   - GPT-OSS Harmony format (`<|channel|>analysis`, `<|channel|>final`, …)
   - Kimi / ChatML wrappers (`<|im_assistant|>`, `<|im_middle|>`, `<|im_end|>`, inline `<|tool_calls_section_begin|>`)
   - XML CoT blocks: `<think>`, `<redacted_thinking>`, `<reasoning>` (paired and orphaned)
   - ChatML noise sanitization (strips `<|im_end|>`, `<|eot_id|>`, `<|endoftext|>`, leading `assistant` prefix, etc.)

### Search semantics

- **`assistant`** field: searches `mainContent` only (excludes reasoning)
- **`reasoning`** field: searches `reasoning` only
- **`chat`** / **`all`**: searches both `mainContent` and `reasoning` (the user-visible text)
- Occurrence counting for the orange "current match" highlight uses the same field scoping and normalized text as the renderer

## What web_chat saves

In JSONL from web_chat, assistant rows typically include:

- **`content`**: full string (historically `raw_content` when the sidecar provides it, otherwise streamed text).
- **`content_parts`** (optional): structured `{ type: thinking | text, … }` parts from the renderer sidecar.

Saving `content_parts` does **not** remove or replace `content`; it only adds optional keys.

## Example trace

Example rollout_viz deep link (local dev; `file` points at `s3://rewardseeker/logs_jsonl/chats/…`):

[Tinker chat JSONL @ rollout 115518009666106, step 1, index 3](http://localhost:3000/?file=s3%3A%2F%2Frewardseeker%2Flogs_jsonl%2Fchats%2F2026-04-07%2Ftinker%3A____719090fc-c5b1-5c3e-be00-b3ac084b67b3%3Atrain%3A0__sampler_weights__000500%2Fexperiment_1%2F20260407_085204_98a72f0e.jsonl&rollout=115518009666106&step=1&index=3)

## Summary

| Source field              | rollout_viz reasoning panel |
|---------------------------|-------------------------------|
| `message.content_parts`   | Yes (preferred when present)  |
| `message.content` (CoT)   | Yes, via `parseContent` with sanitization |
