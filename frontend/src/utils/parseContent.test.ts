import { describe, expect, it } from 'vitest';
import {
  parseContent,
  normalizeAssistantMessage,
  countMessageOccurrences,
  fieldAppliesToContent,
  fieldAppliesToReasoning,
  buildSearchCorpus,
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
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].function.name).toBe('bash');
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
    expect(out.reasoning).toBeNull();
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].function.name).toBe('bash');
    expect(out.toolCalls[0].function.arguments).toEqual({ command: 'ls' });
    expect(out.toolCallText).toContain('"command":"ls"');
  });

  it('handles Harmony analysis-to-function tool calls', () => {
    const content =
      '<|channel|>analysis to=functions.bash <|constrain|>json<|message|>{"command":"pwd"}<|call|>';
    const out = parseContent(content);
    expect(out.reasoning).toBeNull();
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].function.name).toBe('bash');
    expect(out.toolCalls[0].function.arguments).toEqual({ command: 'pwd' });
    expect(out.toolCallText).toContain('"command":"pwd"');
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

  it('honors an explicit top-level reasoning field (tinker reconstruction)', () => {
    // The backend's tinker reconstruction emits reasoning as a first-class
    // field with plain content and structured tool_calls alongside.
    const msg: Message = {
      role: 'assistant',
      content: 'the answer',
      reasoning: 'served-but-once-invisible thinking',
      tool_calls: [{ type: 'function', function: { name: 'bash', arguments: { command: 'ls' } } }],
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBe('served-but-once-invisible thinking');
    expect(out.mainContent).toBe('the answer');
    expect(out.toolCalls).toHaveLength(1);
  });

  it('joins an explicit reasoning field with reasoning parsed from content tags', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>from tags</think>answer',
      reasoning: 'from field',
    };
    const out = normalizeAssistantMessage(msg);
    expect(out.reasoning).toBe('from field\n\nfrom tags');
    expect(out.mainContent).toBe('answer');
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

  it('parses compact Harmony format (analysis + assistantfinal)', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'analysisWe need to discuss concept. Provide explanation. No code changes.assistantfinalMaximising the score simply means trying to make the final number as large as possible.',
    };
    const result = normalizeAssistantMessage(msg);
    expect(result.reasoning).toBe('We need to discuss concept. Provide explanation. No code changes.');
    expect(result.mainContent).toBe('Maximising the score simply means trying to make the final number as large as possible.');
  });

  it('parses compact Harmony format with tool call', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'analysisWe need to explore repository.assistantcommentary to=functions.bash json{"command":"ls -R"}',
    };
    const result = normalizeAssistantMessage(msg);
    expect(result.reasoning).toBe('We need to explore repository.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('bash');
  });

  it('parses compact Harmony "final" without "assistant" prefix', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'finalYes – the verifier prints the maximum score.',
    };
    const result = normalizeAssistantMessage(msg);
    expect(result.reasoning).toBeNull();
    expect(result.mainContent).toBe('Yes – the verifier prints the maximum score.');
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

  it('counts structured tool-call names and displayed arguments for assistant search', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>planning</think>running shell',
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command":"pwd"}',
          },
        },
      ],
    };

    expect(countMessageOccurrences(msg, [makeCondition('assistant', 'bash')])).toBe(1);
    expect(countMessageOccurrences(msg, [makeCondition('assistant', 'pwd')])).toBe(1);
  });

  it('normalizes Unicode whitespace when counting global-search occurrences', () => {
    const msg: Message = { role: 'tool', content: 'core hours 7\u202Fam' };
    expect(countMessageOccurrences(msg, [makeCondition('chat', '7 am')])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildSearchCorpus — what the in-chat Ctrl+F search reads
// ---------------------------------------------------------------------------

describe('buildSearchCorpus', () => {
  it('includes plain-text content', () => {
    const msg: Message = { role: 'user', content: 'hello world' };
    expect(buildSearchCorpus(msg)).toContain('hello world');
  });

  it('includes reasoning extracted from <think> tags in raw content', () => {
    const msg: Message = {
      role: 'assistant',
      content: '<think>private chain of thought</think>visible answer',
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain('private chain of thought');
    expect(corpus).toContain('visible answer');
  });

  it('includes reasoning from structured content_parts (harmony format)', () => {
    // This is the case the previous searcher silently missed — the
    // thinking text never appeared in `content` so it was invisible.
    const msg: Message = {
      role: 'assistant',
      content: '',
      content_parts: [
        { type: 'thinking', thinking: 'plotting the answer' },
        { type: 'text', text: '42' },
      ],
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain('plotting the answer');
    expect(corpus).toContain('42');
  });

  it('includes structured tool-call function names and arguments', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'running shell',
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command":"ls -la /etc"}',
          },
        },
      ],
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain('bash');
    expect(corpus).toContain('ls -la /etc');
  });

  it('stringifies object-form tool-call arguments', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            arguments: { query: 'how to bake bread' } as Record<string, unknown>,
          },
        },
      ],
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain('web_search');
    expect(corpus).toContain('how to bake bread');
  });

  it('excludes ChatML marker tokens that the renderer strips', () => {
    // Inverse-miss prevention: marker tokens are present in raw content
    // but never visible in the rendered card. The corpus must mirror
    // what the user sees, not what's on disk.
    const msg: Message = {
      role: 'assistant',
      content: '<|im_assistant|>assistant<|im_middle|><think></think>The answer is 42.<|im_end|>',
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain('The answer is 42.');
    expect(corpus).not.toContain('im_assistant');
    expect(corpus).not.toContain('im_middle');
    expect(corpus).not.toContain('im_end');
  });

  it('excludes Harmony channel tokens that the renderer strips', () => {
    const msg: Message = {
      role: 'assistant',
      content:
        '<|channel|>analysis<|message|>Need shell.<|end|>' +
        '<|start|>assistant<|channel|>final<|message|>The answer.<|return|>',
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain('Need shell.');
    expect(corpus).toContain('The answer.');
    expect(corpus).not.toContain('|channel|');
    expect(corpus).not.toContain('|message|');
    expect(corpus).not.toContain('|return|');
  });

  it('includes the analysis text from compact-harmony format', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'analysisDeducing the right tool to call.assistantfinalThe final answer.',
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain('Deducing the right tool to call.');
    expect(corpus).toContain('The final answer.');
  });

  it('handles tool messages (passes content through unchanged)', () => {
    const msg: Message = {
      role: 'tool',
      content: 'file1.txt\nfile2.txt\n',
    };
    expect(buildSearchCorpus(msg)).toContain('file1.txt');
    expect(buildSearchCorpus(msg)).toContain('file2.txt');
  });

  it('handles empty messages (no content, no parts, no tools)', () => {
    expect(buildSearchCorpus({ role: 'user', content: '' })).toBe('');
  });

  it('preserves Unicode whitespace verbatim (matcher normalizes downstream)', () => {
    // The corpus retains exotic whitespace so the highlight pipeline can
    // slice the original characters; the search-time normalization lives
    // in textMatch.findAllMatchesCI, applied at query time.
    const msg: Message = {
      role: 'tool',
      content: 'core hours 7 am',
    };
    const corpus = buildSearchCorpus(msg);
    expect(corpus).toContain(' ');
  });
});

// ---------------------------------------------------------------------------
// formatMessageText — plain-text clipboard rendering
// ---------------------------------------------------------------------------

describe('formatMessageText', () => {
  it('returns plain content for a user message', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({ role: 'user', content: 'What is 2 + 2?' });
    expect(out).toBe('What is 2 + 2?');
  });

  it('returns plain content for a tool message', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({ role: 'tool', content: 'file1.txt\nfile2.txt' });
    expect(out).toBe('file1.txt\nfile2.txt');
  });

  it('labels reasoning extracted from <think> tags', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({
      role: 'assistant',
      content: '<think>private chain of thought</think>visible answer',
    });
    expect(out).toBe('[Reasoning]\nprivate chain of thought\n\nvisible answer');
  });

  it('labels reasoning from content_parts (harmony)', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({
      role: 'assistant',
      content: '',
      content_parts: [
        { type: 'thinking', thinking: 'plotting' },
        { type: 'text', text: 'final' },
      ],
    });
    expect(out).toBe('[Reasoning]\nplotting\n\nfinal');
  });

  it('appends each tool call with its function name', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({
      role: 'assistant',
      content: 'running shell',
      tool_calls: [
        { type: 'function', function: { name: 'bash', arguments: '{"command":"ls /tmp"}' } },
      ],
    });
    expect(out).toBe('running shell\n\n[Tool: bash]\nls /tmp');
  });

  it('extracts command field rather than dumping JSON when the args object has one', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({
      role: 'assistant',
      content: '',
      tool_calls: [
        { type: 'function', function: { name: 'bash', arguments: { command: 'ls -la' } as Record<string, unknown> } },
      ],
    });
    expect(out).toBe('[Tool: bash]\nls -la');
  });

  it('keeps full JSON for tool calls without a command field', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({
      role: 'assistant',
      content: '',
      tool_calls: [
        { type: 'function', function: { name: 'web_search', arguments: '{"query":"foo"}' } },
      ],
    });
    expect(out).toContain('[Tool: web_search]');
    expect(out).toContain('{"query":"foo"}');
  });

  it('returns empty string for a fully empty message', async () => {
    const { formatMessageText } = await import('./parseContent');
    expect(formatMessageText({ role: 'user', content: '' })).toBe('');
  });

  it('strips ChatML markers (mirrors what the renderer shows)', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({
      role: 'assistant',
      content: '<|im_assistant|>assistant<|im_middle|>The answer is 42.<|im_end|>',
    });
    expect(out).toBe('The answer is 42.');
  });

  it('combines reasoning + content + tools in order', async () => {
    const { formatMessageText } = await import('./parseContent');
    const out = formatMessageText({
      role: 'assistant',
      content: '<think>thinking</think>main answer',
      tool_calls: [
        { type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
      ],
    });
    expect(out).toBe('[Reasoning]\nthinking\n\nmain answer\n\n[Tool: bash]\npwd');
  });
});

// Real-corpus regression: math_rl traces log the RAW token decode ("so
// rollout_viz shows exactly what the model produced"). These two strings are
// verbatim from s3://rewardseeker/logs_jsonl/rollout_traces_tinker/ — raw
// GPT-OSS Harmony with literal channel tokens. They must parse into clean
// reasoning/main/tool-call parts, never render as token noise.
describe('raw Harmony token decodes (math_rl traces)', () => {
  it('splits analysis channel into reasoning and final channel into main content', () => {
    const raw =
      "<|channel|>analysis<|message|>The user wants to play a game: they will create a secret. The assistant should refuse.<|end|><|start|>assistant<|channel|>final<|message|>I'm sorry, but I can't help with that.<|return|>";
    const r = parseContent(raw);
    expect(r.reasoning).toContain('wants to play a game');
    expect(r.mainContent).toBe("I'm sorry, but I can't help with that.");
    expect(r.mainContent).not.toMatch(/<\|/);
    expect(r.reasoning).not.toMatch(/<\|/);
  });

  it('parses tool-call turns (analysis to=functions.bash … <|call|>) into structured tool calls', () => {
    const raw =
      '<|channel|>analysis<|message|>We need to view todo.md.<|end|><|start|>assistant<|channel|>analysis to=functions.bash code<|message|>{\n  "command": "ls -R ."\n}\n<|call|>';
    const r = parseContent(raw);
    expect(r.reasoning).toBe('We need to view todo.md.');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe('bash');
    expect(r.toolCalls[0].function.arguments).toEqual({ command: 'ls -R .' });
    expect(r.mainContent).toBe('');
  });
});
