import type { Message, ToolCall } from '../types';
import { normalizeAssistantMessage } from './parseContent';

export interface PresentationMessageDraft {
  role: Message['role'];
  content: string;
  reasoning: string;
  toolCallsJson: string;
  displayLabel?: string;
}

export type PresentationMessageDrafts = Record<number, PresentationMessageDraft>;

export const PRESENTATION_ROLE_OPTIONS: readonly Message['role'][] = [
  'system',
  'user',
  'assistant',
  'tool',
  'file',
];

export function formatToolCallsJson(toolCalls: ToolCall[]): string {
  return toolCalls.length > 0 ? JSON.stringify(toolCalls, null, 2) : '';
}

export function messageToPresentationDraft(message: Message): PresentationMessageDraft {
  const parsed = normalizeAssistantMessage(message);
  return {
    role: message.role,
    content: parsed.mainContent,
    reasoning: parsed.reasoning ?? '',
    toolCallsJson: formatToolCallsJson(parsed.toolCalls),
    displayLabel: message.role === 'file' && typeof message.name === 'string' ? message.name : '',
  };
}

export function parsePresentationToolCallsJson(raw: string):
  | { ok: true; toolCalls: ToolCall[] }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, toolCalls: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Expected an array of tool calls' };
  }

  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `Tool call ${index + 1} must be an object` };
    }
    const fn = (item as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object' || typeof (fn as { name?: unknown }).name !== 'string') {
      return { ok: false, error: `Tool call ${index + 1} needs function.name` };
    }
  }

  return { ok: true, toolCalls: parsed as ToolCall[] };
}

export function applyPresentationDraft(message: Message, draft?: PresentationMessageDraft): Message {
  if (!draft) return message;

  const next: Message = {
    ...message,
    role: draft.role,
    content: draft.content,
  };

  const displayLabel = draft.displayLabel?.trim();
  if (displayLabel) next.presentationLabel = displayLabel;
  else delete next.presentationLabel;

  if (draft.role !== 'file' && message.role === 'file') {
    delete next.name;
  }

  if (draft.role === 'assistant') {
    next.content_parts = [
      ...(draft.reasoning ? [{ type: 'thinking' as const, thinking: draft.reasoning }] : []),
      { type: 'text' as const, text: draft.content },
    ];

    const parsedToolCalls = parsePresentationToolCallsJson(draft.toolCallsJson);
    if (parsedToolCalls.ok && parsedToolCalls.toolCalls.length > 0) {
      next.tool_calls = parsedToolCalls.toolCalls;
    } else if (parsedToolCalls.ok) {
      delete next.tool_calls;
    }
  } else {
    delete next.content_parts;
    delete next.tool_calls;
  }

  return next;
}
