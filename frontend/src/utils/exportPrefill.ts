// Transforms rollout_viz samples into the Exact Prefill v2 envelope accepted
// by auto_eval. The legacy `toAutoEvalPrefill(messages)` helper is kept for
// tests and older callers, but UI copy surfaces should use
// `toExactPrefillEnvelope(sample, ...)`.
//
// Exact Prefill v2 preserves the portable replay fields auto_eval/tinker need:
// role, final-text-only content, content_parts, tool_calls, tool_call_id, name,
// openai_response_items, raw_content, tokens, prompt_tokens, and passthrough
// provider metadata. Shape mismatches between rollout_viz and auto_eval are
// reconciled:
//     - `tool_calls[].function.arguments`: object → JSON.stringify
//     - `tool_calls[]` filtered to `type === 'function'`. Auto_eval's
//       structured tool_calls field rejects non-function types
//       (`web_search_call`, etc.); those calls live in
//       `openai_response_items` instead, which is preserved untouched.
//
// See `prefill-json-format-from-rollout-viz.md` §2, §3, and §9 for the
// authoritative mapping table.

import type { Message, Sample, ToolCall } from '../types';

interface AutoEvalToolCall {
  type: 'function';
  id?: string;
  function: { name: string; arguments: string };
}

export interface AutoEvalPrefillMessage {
  role: string;
  content: string;
  content_parts?: unknown[];
  tool_calls?: AutoEvalToolCall[];
  tool_call_id?: string;
  name?: string;
  raw_content?: string;
  tokens?: number[];
  prompt_tokens?: number[];
  openai_response_items?: unknown[];
  [key: string]: unknown;
}

export interface ExactPrefillEnvelope {
  schema_version: 2;
  kind: 'exact_prefill';
  source_app: 'rollout_viz';
  source: Record<string, unknown>;
  messages: AutoEvalPrefillMessage[];
  raw: {
    source_messages?: Message[];
    raw_messages?: unknown[];
    jsonl_entry?: unknown;
    provider_payloads?: unknown[];
  };
  diagnostics: Array<{ level: 'error' | 'warning'; message: string; message_index?: number }>;
}

// Stringify tool-call arguments. Auto_eval's validator requires a string;
// rollout_viz allows either a JSON object or a string. `null`/`undefined`
// arguments become `""` so downstream JSON parses succeed.
function stringifyArgs(args: ToolCall['function']['arguments']): string {
  if (typeof args === 'string') return args;
  if (args == null) return '';
  return JSON.stringify(args);
}

// Untyped reach-through: rollout_viz's `Message` type doesn't declare these
// fields, but the underlying JSONL preserves them when the producer wrote
// them (auto_eval / web_chat_vite).
interface RawMessageExtras {
  tool_call_id?: string;
  name?: string;
  openai_response_items?: unknown[];
  raw_content?: string;
  tokens?: number[];
  prompt_tokens?: number[];
}

const THINK_BLOCK_RE = /<(think|redacted_thinking)>[\s\S]*?<\/\1>/gi;
const THINK_BLOCK_TEST_RE = /<(think|redacted_thinking)>[\s\S]*?<\/\1>/i;

function visibleContent(msg: Message): string {
  const parts = Array.isArray(msg.content_parts) ? msg.content_parts : [];
  const textParts = parts
    .filter((part) => typeof part === 'object' && part !== null)
    .filter((part) =>
      part.type === 'text'
      && typeof part.text === 'string'
      && !['analysis', 'commentary'].includes(part.channel ?? ''),
    )
    .map((part) => part.text!.trim())
    .filter(Boolean);
  if (textParts.length > 0) return textParts.join('\n\n');
  if (parts.length > 0) return (msg.content ?? '').replace(THINK_BLOCK_RE, '').trim();
  return msg.content ?? '';
}

export function toAutoEvalPrefill(messages: Message[]): AutoEvalPrefillMessage[] {
  return messages.map((msg) => {
    const extras = msg as Message & RawMessageExtras;

    const out: AutoEvalPrefillMessage = {
      role: msg.role,
      content: visibleContent(msg),
    };
    for (const [key, value] of Object.entries(msg)) {
      if ([
        'role',
        'content',
        'content_parts',
        'tool_calls',
        'tool_call_id',
        'name',
        'openai_response_items',
        'raw_content',
        'tokens',
        'prompt_tokens',
        'prefilled',
      ].includes(key)) continue;
      out[key] = value;
    }

    // Harmony channels (tinker harmony reasoning + final text).
    if (Array.isArray(msg.content_parts) && msg.content_parts.length > 0) {
      out.content_parts = msg.content_parts;
    }

    // Structured tool calls. Filter to `type: 'function'` and coerce
    // `arguments` to a string. Calls without an `id` are kept verbatim —
    // auto_eval's threading validator will surface a specific error if a
    // tool result later tries to reference them, which is more informative
    // than us silently inventing one.
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const fnCalls = msg.tool_calls
        .filter((tc) => tc.type === 'function')
        .map((tc): AutoEvalToolCall => {
          const tcWithId = tc as ToolCall & { id?: string };
          return {
            type: 'function',
            ...(tcWithId.id !== undefined ? { id: tcWithId.id } : {}),
            function: {
              name: tc.function.name,
              arguments: stringifyArgs(tc.function.arguments),
            },
          };
        });
      if (fnCalls.length > 0) out.tool_calls = fnCalls;
    }

    // Threading metadata for tool messages.
    if (extras.tool_call_id !== undefined) out.tool_call_id = extras.tool_call_id;
    if (extras.name !== undefined) out.name = extras.name;
    if (extras.raw_content !== undefined) out.raw_content = extras.raw_content;
    if (Array.isArray(extras.tokens)) out.tokens = extras.tokens;
    if (Array.isArray(extras.prompt_tokens)) out.prompt_tokens = extras.prompt_tokens;

    // rl_late reasoning + function_call items, opaque to us — pass through.
    if (
      Array.isArray(extras.openai_response_items) &&
      extras.openai_response_items.length > 0
    ) {
      out.openai_response_items = extras.openai_response_items;
    }

    return out;
  });
}

function buildDiagnostics(messages: AutoEvalPrefillMessage[]): ExactPrefillEnvelope['diagnostics'] {
  const diagnostics: ExactPrefillEnvelope['diagnostics'] = [];
  for (const [index, msg] of messages.entries()) {
    if (msg.role === 'assistant') {
      if (THINK_BLOCK_TEST_RE.test(msg.content) && !msg.content_parts?.length && !msg.openai_response_items?.length) {
        diagnostics.push({
          level: 'error',
          message_index: index,
          message: 'Assistant content contains thinking markup but has no structured replay metadata.',
        });
      }
      for (const toolCall of msg.tool_calls ?? []) {
        if (!toolCall.id) {
          diagnostics.push({
            level: 'error',
            message_index: index,
            message: `Tool call ${toolCall.function.name} is missing a stable id.`,
          });
        }
      }
    }
    if (msg.role === 'tool' && !msg.tool_call_id) {
      diagnostics.push({
        level: 'error',
        message_index: index,
        message: 'Tool result is missing tool_call_id and cannot be replayed exactly.',
      });
    }
  }
  return diagnostics;
}

export function toExactPrefillEnvelope(sample: Sample, source: Record<string, unknown> = {}): ExactPrefillEnvelope {
  const messages = toAutoEvalPrefill(sample.messages);
  // raw_jsonl_entry is a load-time snapshot: grades appended this session
  // (comments, deletion tombstones) exist only in sample.grades. Overlay the
  // live grades so the exported raw entry is never missing a deletion record
  // — nothing is removed here, the archival copy stays complete.
  const rawEntry = sample.raw_jsonl_entry;
  const jsonlEntry = rawEntry
    ? (sample.grades ? { ...(rawEntry as Record<string, unknown>), grades: sample.grades } : rawEntry)
    : {
        messages: sample.messages,
        attributes: sample.attributes,
        timestamp: sample.timestamp,
        grades: sample.grades,
      };
  return {
    schema_version: 2,
    kind: 'exact_prefill',
    source_app: 'rollout_viz',
    source: {
      file: sample.attributes?.source_file,
      experiment_name: sample.attributes?.experiment_name,
      step: sample.attributes?.step,
      sample_index: sample.attributes?.sample_index,
      rollout_n: sample.attributes?.rollout_n,
      ...source,
    },
    messages,
    raw: {
      source_messages: sample.messages,
      raw_messages: sample.raw_messages,
      jsonl_entry: jsonlEntry,
    },
    diagnostics: buildDiagnostics(messages),
  };
}
