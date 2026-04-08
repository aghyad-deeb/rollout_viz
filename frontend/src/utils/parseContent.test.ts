import { describe, expect, it } from 'vitest';
import {
  parseContent,
  normalizeAssistantMessage,
  countMessageOccurrences,
  fieldAppliesToContent,
  fieldAppliesToReasoning,
} from './parseContent';
import type { Message, SearchCondition } from '../types';

// ---------------------------------------------------------------------------
// parseContent — standard CoT formats
// ---------------------------------------------------------------------------

describe('parseContent', () => {
  it('parses paired <think> tags', () => {
    const out = parseContent('<think>step by step</think>Final answer');
    expect(out.reasoning).toBe('step by step');
    expect(out.mainContent).toBe('Final answer');
    expect(out.toolCallText).toBeNull();
  });

  it('parses paired <reasoning> tags', () => {
    const out = parseContent('<reasoning>analysis here</reasoning>Conclusion');
    expect(out.reasoning).toBe('analysis here');
    expect(out.mainContent).toBe('Conclusion');
  });

  it('parses paired <redacted_thinking> tags', () => {
    const out = parseContent('<redacted_thinking>hidden plan</redacted_thinking>Visible answer');
    expect(out.reasoning).toBe('hidden plan');
    expect(out.mainContent).toBe('Visible answer');
  });

  it('handles empty <think></think> as null reasoning', () => {
    const out = parseContent('<think></think>Main text');
    expect(out.reasoning).toBeNull();
    expect(out.mainContent).toBe('Main text');
  });

  it('handles orphaned </think> without opening tag', () => {
    const out = parseContent('orphaned reasoning</think>Visible text');
    expect(out.reasoning).toBe('orphaned reasoning');
    expect(out.mainContent).toBe('Visible text');
  });

  it('handles orphaned </redacted_thinking> without opening tag', () => {
    const out = parseContent('internal notes</redacted_thinking>Public answer');
    expect(out.reasoning).toBe('internal notes');
    expect(out.mainContent).toBe('Public answer');
  });

  it('returns null reasoning and full content when no CoT tags', () => {
    const out = parseContent('Just a plain response.');
    expect(out.reasoning).toBeNull();
    expect(out.mainContent).toBe('Just a plain response.');
  });

  // --- Kimi / ChatML format ---

  it('strips Kimi ChatML wrapper tokens', () => {
    const content = '<|im_assistant|>assistant<|im_middle|><think></think>Hello world<|im_end|>';
    const out = parseContent(content);
    expect(out.reasoning).toBeNull();
    expect(out.mainContent).toBe('Hello world');
    expect(out.toolCallText).toBeNull();
  });

  it('extracts Kimi inline tool calls', () => {
    const content =
      '<|im_assistant|>assistant<|im_middle|><think></think> Checking files ' +
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.bash:0' +
      '<|tool_call_argument_begin|>{"command": "ls -la data/"}<|tool_call_end|>' +
      '<|tool_calls_section_end|><|im_end|>';
    const out = parseContent(content);
    expect(out.reasoning).toBeNull();
    expect(out.mainContent).toBe('Checking files');
    expect(out.toolCallText).toContain('[tool call: bash]');
    expect(out.toolCallText).toContain('ls -la data/');
  });

  it('preserves reasoning with Kimi wrapper', () => {
    const content =
      '<|im_assistant|>assistant<|im_middle|><think>internal plan</think>The answer is 42.<|im_end|>';
    const out = parseContent(content);
    expect(out.reasoning).toBe('internal plan');
    expect(out.mainContent).toBe('The answer is 42.');
  });

  it('strips <|im_start|> assistant prefix', () => {
    const content = '<|im_start|>assistant\nHello<|im_end|>';
    const out = parseContent(content);
    expect(out.mainContent).toBe('Hello');
  });

  it('strips <|eot_id|> suffix', () => {
    const content = 'Response text<|eot_id|>';
    const out = parseContent(content);
    expect(out.mainContent).toBe('Response text');
  });

  it('handles real Kimi trace from fetched example', () => {
    const content =
      '<|im_assistant|>assistant<|im_middle|><think></think> Based on the safety flag, ' +
      'I cannot provide the odds ratio.<|im_end|>';
    const out = parseContent(content);
    expect(out.reasoning).toBeNull();
    expect(out.mainContent).toBe(
      'Based on the safety flag, I cannot provide the odds ratio.'
    );
    expect(out.mainContent).not.toContain('<|');
    expect(out.mainContent).not.toContain('assistant');
  });

  // --- ChatML noise in orphaned-close path ---

  it('sanitizes ChatML noise before orphaned closing tag', () => {
    const content = '<|redacted_im_assistant|>assistant\nnoise</redacted_thinking>Visible';
    const out = parseContent(content);
    expect(out.reasoning).toBe('noise');
    expect(out.mainContent).toBe('Visible');
  });

  // --- Harmony format (existing behavior preserved) ---

  it('handles Harmony analysis + final', () => {
    const content =
      '<|channel|>analysis<|message|>Thinking about it<|end|>' +
      '<|channel|>final<|message|>The answer<|end|>';
    const out = parseContent(content);
    expect(out.reasoning).toBe('Thinking about it');
    expect(out.mainContent).toBe('The answer');
  });

  it('handles Harmony with commentary', () => {
    const content =
      '<|channel|>commentary to=functions.bash<|message|>{"command":"ls"}<|end|>';
    const out = parseContent(content);
    expect(out.reasoning).toContain('[tool call: bash]');
  });
});

// ---------------------------------------------------------------------------
// normalizeAssistantMessage — content_parts preference
// ---------------------------------------------------------------------------

describe('normalizeAssistantMessage', () => {
  it('returns raw content for non-assistant roles', () => {
    const msg: Message = { role: 'user', content: 'Hello' };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBeNull();
    expect(out.mainContent).toBe('Hello');
  });

  it('prefers content_parts when present', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>raw thinking</think>raw answer',
      content_parts: [
        { type: 'thinking', thinking: 'structured thinking' },
        { type: 'text', text: 'structured answer' },
      ],
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBe('structured thinking');
    expect(out.mainContent).toBe('structured answer');
  });

  it('falls back to parseContent when content_parts is empty', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>from content</think>Main text',
      content_parts: [],
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBe('from content');
    expect(out.mainContent).toBe('Main text');
  });

  it('falls back to parseContent when content_parts is absent', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<reasoning>step</reasoning>Answer',
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBe('step');
    expect(out.mainContent).toBe('Answer');
  });

  it('handles content_parts with only thinking (no text part)', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      content_parts: [{ type: 'thinking', thinking: 'just thinking' }],
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBe('just thinking');
    expect(out.mainContent).toBe('');
  });

  it('handles content_parts with multiple thinking and text parts', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      content_parts: [
        { type: 'thinking', thinking: 'step 1' },
        { type: 'text', text: 'partial answer' },
        { type: 'thinking', thinking: 'step 2' },
        { type: 'text', text: 'final answer' },
      ],
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBe('step 1\n\nstep 2');
    expect(out.mainContent).toBe('partial answer\nfinal answer');
  });

  it('cleans Kimi tokens from assistant content', () => {
    const msg: Message = {
      role: 'assistant',
      content:
        '<|im_assistant|>assistant<|im_middle|><think></think> The answer is 42.<|im_end|>',
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.mainContent).toBe('The answer is 42.');
    expect(out.mainContent).not.toContain('<|');
  });
});

// ---------------------------------------------------------------------------
// fieldAppliesToContent / fieldAppliesToReasoning
// ---------------------------------------------------------------------------

describe('fieldAppliesToContent', () => {
  it('chat and all apply to all roles', () => {
    expect(fieldAppliesToContent('chat', 'user')).toBe(true);
    expect(fieldAppliesToContent('all', 'assistant')).toBe(true);
    expect(fieldAppliesToContent('chat', 'tool')).toBe(true);
  });

  it('role-specific fields match only their role', () => {
    expect(fieldAppliesToContent('assistant', 'assistant')).toBe(true);
    expect(fieldAppliesToContent('assistant', 'user')).toBe(false);
    expect(fieldAppliesToContent('user', 'user')).toBe(true);
    expect(fieldAppliesToContent('user', 'assistant')).toBe(false);
  });

  it('reasoning field never applies to content', () => {
    expect(fieldAppliesToContent('reasoning', 'assistant')).toBe(false);
  });
});

describe('fieldAppliesToReasoning', () => {
  it('only applies to assistant role', () => {
    expect(fieldAppliesToReasoning('reasoning', 'user')).toBe(false);
    expect(fieldAppliesToReasoning('reasoning', 'assistant')).toBe(true);
  });

  it('chat, all, reasoning apply to assistant reasoning', () => {
    expect(fieldAppliesToReasoning('chat', 'assistant')).toBe(true);
    expect(fieldAppliesToReasoning('all', 'assistant')).toBe(true);
    expect(fieldAppliesToReasoning('reasoning', 'assistant')).toBe(true);
  });

  it('assistant field excludes reasoning', () => {
    expect(fieldAppliesToReasoning('assistant', 'assistant')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countMessageOccurrences — search/highlight parity
// ---------------------------------------------------------------------------

describe('countMessageOccurrences', () => {
  const makeCondition = (field: string, term: string): SearchCondition => ({
    id: '1',
    field: field as SearchCondition['field'],
    operator: 'contains',
    term,
  });

  it('counts occurrences in mainContent for assistant field', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>hello</think>hello world hello',
    };
    const count = countMessageOccurrences(msg, [makeCondition('assistant', 'hello')]);
    expect(count).toBe(2);
  });

  it('counts occurrences in reasoning for reasoning field', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>hello hello</think>world',
    };
    const count = countMessageOccurrences(msg, [makeCondition('reasoning', 'hello')]);
    expect(count).toBe(2);
  });

  it('counts in both reasoning and content for chat field', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>hello</think>hello',
    };
    const count = countMessageOccurrences(msg, [makeCondition('chat', 'hello')]);
    expect(count).toBe(2);
  });

  it('returns 0 for non-matching role', () => {
    const msg: Message = { role: 'user', content: 'hello' };
    const count = countMessageOccurrences(msg, [makeCondition('assistant', 'hello')]);
    expect(count).toBe(0);
  });

  it('counts user content for chat field', () => {
    const msg: Message = { role: 'user', content: 'hello hello' };
    const count = countMessageOccurrences(msg, [makeCondition('chat', 'hello')]);
    expect(count).toBe(2);
  });

  it('returns 0 for not_contains operator', () => {
    const msg: Message = { role: 'assistant', content: 'hello' };
    const cond: SearchCondition = { id: '1', field: 'assistant', operator: 'not_contains', term: 'hello' };
    expect(countMessageOccurrences(msg, [cond])).toBe(0);
  });

  it('ignores token noise when counting in Kimi content', () => {
    const msg: Message = {
      role: 'assistant',
      content:
        '<|im_assistant|>assistant<|im_middle|><think></think> The answer is 42.<|im_end|>',
    };
    const count = countMessageOccurrences(msg, [makeCondition('assistant', 'answer')]);
    expect(count).toBe(1);
  });

  it('does not count token artifacts as content', () => {
    const msg: Message = {
      role: 'assistant',
      content:
        '<|im_assistant|>assistant<|im_middle|><think></think> Hello world<|im_end|>',
    };
    const countAssistant = countMessageOccurrences(msg, [
      makeCondition('assistant', 'im_assistant'),
    ]);
    expect(countAssistant).toBe(0);
  });

  it('uses content_parts when present', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'raw content with hello',
      content_parts: [
        { type: 'thinking', thinking: 'thinking about hello' },
        { type: 'text', text: 'structured hello answer' },
      ],
    };
    const count = countMessageOccurrences(msg, [makeCondition('chat', 'hello')]);
    expect(count).toBe(2);
  });
});
