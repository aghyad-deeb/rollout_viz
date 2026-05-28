import { describe, expect, it } from 'vitest';
import { applyPresentationDraft, messageToPresentationDraft, parsePresentationToolCallsJson } from './presentationDraft';
import { normalizeAssistantMessage } from './parseContent';
import type { Message } from '../types';

describe('presentationDraft', () => {
  it('builds editable displayed fields from an assistant message', () => {
    const message: Message = {
      role: 'assistant',
      content: '<think>hidden chain</think>visible answer',
    };

    expect(messageToPresentationDraft(message)).toMatchObject({
      role: 'assistant',
      reasoning: 'hidden chain',
      content: 'visible answer',
      toolCallsJson: '',
    });
  });

  it('applies a temporary draft without mutating the original message', () => {
    const message: Message = { role: 'user', content: 'original' };
    const rendered = applyPresentationDraft(message, {
      role: 'assistant',
      content: 'edited answer',
      reasoning: 'edited reasoning',
      toolCallsJson: '',
    });

    expect(message).toEqual({ role: 'user', content: 'original' });
    expect(rendered.role).toBe('assistant');
    expect(normalizeAssistantMessage(rendered)).toMatchObject({
      reasoning: 'edited reasoning',
      mainContent: 'edited answer',
      toolCalls: [],
    });
  });

  it('applies a temporary display label without mutating the original message', () => {
    const message: Message = { role: 'user', content: 'original' };
    const rendered = applyPresentationDraft(message, {
      role: 'assistant',
      content: 'edited answer',
      reasoning: '',
      toolCallsJson: '',
      displayLabel: 'GPT-5.1',
    });

    expect(message).toEqual({ role: 'user', content: 'original' });
    expect(rendered).toMatchObject({
      role: 'assistant',
      content: 'edited answer',
      presentationLabel: 'GPT-5.1',
    });
  });

  it('validates tool-call JSON before it is rendered', () => {
    expect(parsePresentationToolCallsJson('[]')).toEqual({ ok: true, toolCalls: [] });
    expect(parsePresentationToolCallsJson('{"bad": true}')).toMatchObject({ ok: false });
  });
});
