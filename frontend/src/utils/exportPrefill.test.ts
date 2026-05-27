// Tests for `toAutoEvalPrefill`. Each combination is keyed to a section of
// `prefill-json-format-from-rollout-viz.md`; if those numbers change, update
// the references here too.

import { describe, it, expect } from 'vitest';
import { toAutoEvalPrefill, toExactPrefillEnvelope } from './exportPrefill';
import type { Message, Sample } from '../types';

// Helper: type-cast a JSONL-shaped row that has fields rollout_viz's Message
// type doesn't declare (tool_call_id, name, openai_response_items, …).
function row(m: Record<string, unknown>): Message {
  return m as unknown as Message;
}

describe('toAutoEvalPrefill', () => {
  it('5.1 plain text — round-trips role/content unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: "What's 2 + 2?" },
      { role: 'assistant', content: '4' },
    ];
    expect(toAutoEvalPrefill(messages)).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: "What's 2 + 2?" },
      { role: 'assistant', content: '4' },
    ]);
  });

  it('5.2 xml + tools — preserves tool_calls[].id, tool_call_id, name', () => {
    const messages: Message[] = [
      row({ role: 'system', content: 'helpful' }),
      row({ role: 'user', content: 'List /tmp.' }),
      row({
        role: 'assistant',
        content: "I'll list /tmp.\n<bash>ls /tmp</bash>",
        tool_calls: [
          {
            type: 'function',
            id: 'call_xml_01',
            function: { name: 'bash', arguments: '{"command":"ls /tmp"}' },
          },
        ],
      }),
      row({
        role: 'tool',
        tool_call_id: 'call_xml_01',
        name: 'bash',
        content: 'file1.txt\nfile2.txt\n',
      }),
    ];
    const out = toAutoEvalPrefill(messages);
    expect(out[2].tool_calls).toEqual([
      {
        type: 'function',
        id: 'call_xml_01',
        function: { name: 'bash', arguments: '{"command":"ls /tmp"}' },
      },
    ]);
    expect(out[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_xml_01',
      name: 'bash',
      content: 'file1.txt\nfile2.txt\n',
    });
  });

  it('5.3 harmony reasoning — preserves content_parts', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: '408.',
        content_parts: [
          { type: 'thinking', thinking: '17 × 20 = 340. 17 × 4 = 68. 340 + 68 = 408.' },
          { type: 'text', text: '408.' },
        ],
      }),
    ];
    expect(toAutoEvalPrefill(messages)[0].content_parts).toEqual([
      { type: 'thinking', thinking: '17 × 20 = 340. 17 × 4 = 68. 340 + 68 = 408.' },
      { type: 'text', text: '408.' },
    ]);
  });

  it('5.4 harmony + tools — keeps both content_parts and tool_calls', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: 'Running ls now.',
        content_parts: [
          { type: 'thinking', thinking: 'User wants directory listing.' },
          { type: 'text', text: 'Running ls now.' },
        ],
        tool_calls: [
          {
            type: 'function',
            id: 'call_h_01',
            function: { name: 'bash', arguments: '{"command":"ls /tmp"}' },
          },
        ],
      }),
    ];
    const out = toAutoEvalPrefill(messages)[0];
    expect(out.content_parts).toHaveLength(2);
    expect(out.tool_calls).toHaveLength(1);
  });

  it('5.5 rl_late reasoning — preserves openai_response_items verbatim', () => {
    const opaqueItem = {
      type: 'reasoning',
      id: 'rs_01',
      encrypted_content: '<opaque base64>',
      summary: [{ type: 'summary_text', text: 'Computing 17 * 24.' }],
    };
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: '408.',
        openai_response_items: [opaqueItem],
      }),
    ];
    expect(toAutoEvalPrefill(messages)[0].openai_response_items).toEqual([opaqueItem]);
  });

  it('5.6 rl_late + tools — both tool_calls and openai_response_items survive', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: 'Running ls.',
        tool_calls: [
          {
            type: 'function',
            id: 'call_rl_01',
            function: { name: 'bash', arguments: '{"command":"ls /tmp"}' },
          },
        ],
        openai_response_items: [
          { type: 'reasoning', id: 'rs_01', encrypted_content: 'op' },
          { type: 'function_call', id: 'fc_01', call_id: 'call_rl_01', name: 'bash', arguments: '{"command":"ls /tmp"}' },
        ],
      }),
    ];
    const out = toAutoEvalPrefill(messages)[0];
    expect(out.tool_calls?.[0].id).toBe('call_rl_01');
    expect(out.openai_response_items).toHaveLength(2);
  });

  // ── shape conversions ────────────────────────────────────────────────

  it('stringifies tool_calls[].function.arguments when given as object', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            id: 'call_1',
            function: { name: 'bash', arguments: { command: 'ls /tmp' } },
          },
        ],
      }),
    ];
    const arg = toAutoEvalPrefill(messages)[0].tool_calls![0].function.arguments;
    expect(typeof arg).toBe('string');
    expect(JSON.parse(arg)).toEqual({ command: 'ls /tmp' });
  });

  it('passes through string-form arguments unchanged', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            id: 'call_1',
            function: { name: 'bash', arguments: '{"command":"ls"}' },
          },
        ],
      }),
    ];
    expect(toAutoEvalPrefill(messages)[0].tool_calls![0].function.arguments)
      .toBe('{"command":"ls"}');
  });

  it('drops tool_calls entries whose type is not "function"', () => {
    // `web_search_call` etc. live in openai_response_items, not tool_calls.
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'web_search_call',
            id: 'ws_1',
            function: { name: 'web_search', arguments: {} },
          },
          {
            type: 'function',
            id: 'call_1',
            function: { name: 'bash', arguments: '{}' },
          },
        ],
      }),
    ];
    const out = toAutoEvalPrefill(messages)[0];
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls![0].id).toBe('call_1');
  });

  it('omits tool_calls entirely when filtering leaves an empty array', () => {
    // Auto_eval rejects empty `tool_calls: []` per §8.
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: 'no real fn calls here',
        tool_calls: [
          { type: 'web_search_call', id: 'ws_1', function: { name: 'x', arguments: '{}' } },
        ],
      }),
    ];
    expect(toAutoEvalPrefill(messages)[0].tool_calls).toBeUndefined();
  });

  it('preserves tool_calls without an id (validator decides if it errors)', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      }),
    ];
    const tc = toAutoEvalPrefill(messages)[0].tool_calls![0];
    expect(tc.function.name).toBe('bash');
    expect('id' in tc).toBe(false);
  });

  // ── explicit drops ───────────────────────────────────────────────────

  it('preserves unknown provider fields such as Anthropic-style reasoning', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: 'final',
        reasoning: 'thinking aloud',
      }),
    ];
    const out = toAutoEvalPrefill(messages)[0] as Record<string, unknown>;
    expect(out.reasoning).toBe('thinking aloud');
    expect(out.content).toBe('final');
  });

  it('preserves tokens / prompt_tokens but still drops prefilled UI state', () => {
    const messages: Message[] = [
      row({
        role: 'assistant',
        content: 'x',
        tokens: [1, 2, 3],
        prompt_tokens: [4, 5],
        prefilled: true,
      }),
    ];
    const out = toAutoEvalPrefill(messages)[0] as Record<string, unknown>;
    expect(out.tokens).toEqual([1, 2, 3]);
    expect(out.prompt_tokens).toEqual([4, 5]);
    expect(out).not.toHaveProperty('prefilled');
  });

  it('omits empty content_parts and empty tool_calls', () => {
    const messages: Message[] = [
      row({ role: 'assistant', content: 'x', content_parts: [], tool_calls: [] }),
    ];
    const out = toAutoEvalPrefill(messages)[0] as Record<string, unknown>;
    expect(out).not.toHaveProperty('content_parts');
    expect(out).not.toHaveProperty('tool_calls');
  });

  it('coerces missing content to empty string (defensive — auto_eval requires the field)', () => {
    const messages: Message[] = [row({ role: 'user' })];
    expect(toAutoEvalPrefill(messages)[0].content).toBe('');
  });
});

describe('toExactPrefillEnvelope', () => {
  it('emits an Exact Prefill v2 envelope with raw archival data', () => {
    const rawJsonlEntry = {
      messages: [
        {
          role: 'assistant',
          content: 'done',
          content_parts: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'text', text: 'done' },
          ],
          raw_content: '<raw>',
          tokens: [1],
          prompt_tokens: [2],
        },
      ],
      attributes: {
        step: 3,
        sample_index: 4,
        rollout_n: 5,
        reward: 0,
        data_source: 'x',
        experiment_name: 'exp',
        is_validate: false,
      },
      timestamp: 'now',
      raw_messages: [{ provider: 'payload' }],
    };
    const sample = {
      ...rawJsonlEntry,
      id: 0,
      raw_messages: rawJsonlEntry.raw_messages,
      raw_jsonl_entry: rawJsonlEntry,
    } as unknown as Sample;
    const envelope = toExactPrefillEnvelope(sample, {
      file: 's3://bucket/key.jsonl',
    });
    expect(envelope).toMatchObject({
      schema_version: 2,
      kind: 'exact_prefill',
      source_app: 'rollout_viz',
      source: { file: 's3://bucket/key.jsonl', step: 3, rollout_n: 5 },
      diagnostics: [],
    });
    expect(envelope.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'done',
      raw_content: '<raw>',
      tokens: [1],
      prompt_tokens: [2],
    });
    expect(envelope.raw.jsonl_entry).toBe(rawJsonlEntry);
  });

  it('diagnoses missing exact tool threading metadata', () => {
    const envelope = toExactPrefillEnvelope({
      id: 0,
      messages: [
        row({
          role: 'assistant',
          content: '',
          tool_calls: [{ type: 'function', function: { name: 'bash', arguments: '{}' } }],
        }),
        row({ role: 'tool', content: 'ok', name: 'bash' }),
      ],
      attributes: {
        step: 0,
        sample_index: 0,
        rollout_n: 0,
        reward: 0,
        data_source: '',
        experiment_name: '',
        is_validate: false,
      },
      timestamp: '',
    });
    expect(envelope.diagnostics.map((d) => d.message)).toEqual([
      'Tool call bash is missing a stable id.',
      'Tool result is missing tool_call_id and cannot be replayed exactly.',
    ]);
  });
});
