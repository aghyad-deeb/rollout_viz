import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  formatRolloutForChat,
  buildSystemPrompt,
  loadChatModel,
  saveChatModel,
} from './rolloutChat';
import { makeSample, makeMessage, makeAttributes } from '../test/fixtures';
import type { Message } from '../types';

describe('rolloutChat', () => {
  it('exposes the three frontier models', () => {
    expect(CHAT_MODELS.map((m) => m.id)).toEqual([
      'anthropic/claude-opus-4-7',
      'gpt-5.5',
      'openrouter/google/gemini-3.1-pro-preview',
    ]);
    expect(DEFAULT_CHAT_MODEL).toBe('anthropic/claude-opus-4-7');
  });

  it('formatRolloutForChat includes the transcript and attributes', () => {
    const sample = makeSample({
      messages: [makeMessage('user', 'add 2+2'), makeMessage('assistant', 'the answer is 5')],
      attributes: { ...makeAttributes(), experiment_name: 'exp-x', rollout_n: 7, step: 3 },
    });
    const txt = formatRolloutForChat(sample);
    expect(txt).toContain('exp-x');
    expect(txt).toContain('add 2+2');
    expect(txt).toContain('the answer is 5');
    expect(txt).toContain('## Conversation');
    expect(txt).toContain('## Grades');
    expect(txt).toContain('(none)'); // no grades → "(none)"
  });

  it('formatRolloutForChat renders grades when present', () => {
    const sample = makeSample({
      messages: [makeMessage('user', 'q')],
      grades: {
        accuracy: [
          {
            grade: 0.4,
            grade_type: 'float',
            quotes: [{ message_index: 0, start: 0, end: 1, text: 'q' }],
            explanation: 'partly right',
            model: 'gpt-4o',
            prompt_version: 'v1',
            timestamp: 't',
          },
        ],
      },
    });
    const txt = formatRolloutForChat(sample);
    expect(txt).toContain('accuracy: 0.4');
    expect(txt).toContain('partly right');
    expect(txt).toContain('quote [message 0]');
  });

  it('formatRolloutForChat dumps reasoning, tool calls, content parts and tool results', () => {
    const sample = makeSample({
      messages: [
        {
          role: 'assistant',
          content: 'visible answer',
          reasoning: 'my private reasoning',
          content_parts: [{ type: 'thinking', thinking: 'channel thoughts' }],
          tool_calls: [
            { type: 'function', id: 'c1', function: { name: 'bash', arguments: '{"command":"ls -la"}' } },
          ],
        } as Message,
        { role: 'tool', name: 'bash', tool_call_id: 'c1', content: 'file1\nfile2' } as Message,
      ],
    });
    const txt = formatRolloutForChat(sample);
    expect(txt).toContain('my private reasoning'); // reasoning field
    expect(txt).toContain('channel thoughts'); // content_parts thinking
    expect(txt).toContain('visible answer'); // content
    expect(txt).toContain('bash'); // tool-call name
    expect(txt).toContain('ls -la'); // tool-call arguments
    expect(txt).toContain('file1'); // tool-result content
    expect(txt).toContain('tool_call_id: c1'); // tool message linkage
  });

  it('buildSystemPrompt wraps the rollout with instructions', () => {
    const sp = buildSystemPrompt(makeSample());
    expect(sp).toContain('research assistant');
    expect(sp).toContain('# Rollout under discussion');
  });

  it('loadChatModel / saveChatModel round-trip through localStorage', () => {
    localStorage.clear();
    expect(loadChatModel()).toBe(DEFAULT_CHAT_MODEL);
    saveChatModel('gpt-5.5');
    expect(loadChatModel()).toBe('gpt-5.5');
    // An unknown stored value falls back to the default.
    saveChatModel('not-a-real-model');
    expect(loadChatModel()).toBe(DEFAULT_CHAT_MODEL);
  });
});
