// Shared utility for parsing assistant message content into reasoning (CoT) and main content.
// Handles multiple formats:
//   1. <think>...</think>, <reasoning>...</reasoning>, <redacted_thinking>...</redacted_thinking>
//   2. Orphaned </think> or </redacted_thinking> without opening tag (content before it is reasoning)
//   3. GPT-OSS Harmony format: <|channel|>analysis/commentary/final with <|message|>
//   4. Kimi/ChatML format: <|im_assistant|>...<|im_middle|>...<|im_end|> with inline tool calls

import type { Message, SearchCondition, SearchField } from '../types';

// --- Harmony regexes ---

const H = '(?:[^<]*(?:<(?!\\|message\\|>)[^<]*)*)';

const HARMONY_ANALYSIS_RE = new RegExp(
  `<\\|channel\\|>analysis${H}<\\|message\\|>([\\s\\S]*?)(?:<\\|end\\|>|<\\|call\\|>)`, 'g'
);
const HARMONY_FINAL_RE = new RegExp(
  `<\\|channel\\|>final${H}<\\|message\\|>([\\s\\S]*?)(?:<\\|return\\|>|<\\|end\\|>|$)`
);
const HARMONY_COMMENTARY_RE = new RegExp(
  `<\\|channel\\|>commentary\\s+to=(\\S+)${H}<\\|message\\|>([\\s\\S]*?)(?:<\\|call\\|>|<\\|end\\|>)`, 'g'
);
const HARMONY_STRIP_RE = /<\|(?:start|end|return|call|message|channel|constrain)\|>[^<]*/g;

// --- CoT tag variants ---

const COT_OPEN = '(?:<think>|<redacted_thinking>|<reasoning>)';
const COT_CLOSE = '(?:</think>|</redacted_thinking>|</reasoning>)';
const COT_PAIRED_RE = new RegExp(`${COT_OPEN}([\\s\\S]*?)${COT_CLOSE}`);
const COT_PAIRED_STRIP_RE = new RegExp(`${COT_OPEN}[\\s\\S]*?${COT_CLOSE}`, 'g');
const COT_ORPHANED_RE = new RegExp(`^([\\s\\S]*?)${COT_CLOSE}`);
const COT_CLOSE_STRIP_RE = new RegExp(COT_CLOSE, 'g');

// --- ChatML / Kimi detection and extraction ---

const CHATML_DETECT_RE = /<\|(?:im_assistant|im_middle|im_start|im_end|tool_calls_section_begin)\|>/;
const KIMI_TOOL_SECTION_RE = /<\|tool_calls_section_begin\|>([\s\S]*?)<\|tool_calls_section_end\|>/g;
const KIMI_TOOL_CMD_RE = /functions\.(\w+):\S+[\s\S]*?\{[^}]*"command"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export interface ParsedContent {
  reasoning: string | null;
  mainContent: string;
  toolCallText: string | null;
}

/** Remove ChatML / special-token noise from a text segment. */
function sanitizeSegment(fragment: string): string {
  let s = fragment.trim();
  if (!s) return s;
  s = s.replace(/^<\|redacted_im_assistant\|>\s*/i, '');
  s = s.replace(/^<\|im_assistant\|>\s*assistant\s*<\|im_middle\|>\s*/i, '');
  s = s.replace(/^<\|im_start\|>\s*assistant\s*\n?/i, '');
  s = s.replace(/^assistant\s*\n?/i, '');
  s = s.replace(/<\|im_end\|>\s*$/gi, '');
  s = s.replace(/<\|redacted_im_end\|>\s*$/gi, '');
  s = s.replace(/<\|eot_id\|>\s*$/gi, '');
  s = s.replace(/<\|endoftext\|>\s*$/gi, '');
  return s.trim();
}

/** Strip ChatML/Kimi wrapper tokens and extract inline tool-call sections. */
function preprocessChatML(content: string): { cleaned: string; toolCallText: string | null } {
  let cleaned = content;

  // Strip prefix wrappers
  cleaned = cleaned.replace(/^<\|im_assistant\|>\s*assistant\s*<\|im_middle\|>\s*/i, '');
  cleaned = cleaned.replace(/^<\|im_start\|>\s*assistant\s*\n?/i, '');

  // Strip suffix wrappers
  cleaned = cleaned.replace(/<\|im_end\|>\s*$/gi, '');
  cleaned = cleaned.replace(/<\|eot_id\|>\s*$/gi, '');
  cleaned = cleaned.replace(/<\|endoftext\|>\s*$/gi, '');

  // Extract inline Kimi tool calls
  const toolCalls: string[] = [];
  KIMI_TOOL_SECTION_RE.lastIndex = 0;
  let match;
  while ((match = KIMI_TOOL_SECTION_RE.exec(cleaned)) !== null) {
    const tcContent = match[1];
    const cmdMatch = tcContent.match(KIMI_TOOL_CMD_RE);
    if (cmdMatch) {
      const cmd = cmdMatch[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      toolCalls.push(`[tool call: ${cmdMatch[1]}]\n${cmd}`);
    } else {
      const raw = tcContent.replace(/<\|[^|]+\|>/g, '').trim();
      if (raw) toolCalls.push(raw);
    }
  }

  // Remove tool-call sections from cleaned content
  cleaned = cleaned.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, '');

  return {
    cleaned: cleaned.trim(),
    toolCallText: toolCalls.length > 0 ? toolCalls.join('\n\n') : null,
  };
}

export function parseContent(content: string): ParsedContent {
  // --- Pre-process: strip ChatML/Kimi wrapper tokens ---
  let toolCallText: string | null = null;
  let processedContent = content;

  if (CHATML_DETECT_RE.test(content)) {
    const result = preprocessChatML(content);
    processedContent = result.cleaned;
    toolCallText = result.toolCallText;
  }

  // --- GPT-OSS Harmony format ---
  if (processedContent.includes('<|channel|>') || processedContent.includes('<|message|>')) {
    const reasoningParts: string[] = [];
    let mainContent = '';

    HARMONY_ANALYSIS_RE.lastIndex = 0;
    let match;
    while ((match = HARMONY_ANALYSIS_RE.exec(processedContent)) !== null) {
      const text = match[1].trim();
      if (text) reasoningParts.push(text);
    }

    const finalMatch = processedContent.match(HARMONY_FINAL_RE);
    if (finalMatch) {
      mainContent = finalMatch[1].trim();
    }

    HARMONY_COMMENTARY_RE.lastIndex = 0;
    while ((match = HARMONY_COMMENTARY_RE.exec(processedContent)) !== null) {
      const toolName = match[1].replace('functions.', '');
      const args = match[2].trim();
      reasoningParts.push(`[tool call: ${toolName}]\n${args}`);
    }

    if (!mainContent && reasoningParts.length === 0) {
      mainContent = processedContent.replace(HARMONY_STRIP_RE, '').trim();
    }

    return {
      reasoning: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : null,
      mainContent,
      toolCallText,
    };
  }

  // --- Standard CoT XML format ---
  const thinkMatch = processedContent.match(COT_PAIRED_RE);
  const orphanedMatch = !thinkMatch ? processedContent.match(COT_ORPHANED_RE) : null;

  let reasoning: string | null = null;
  if (thinkMatch) {
    const r = sanitizeSegment(thinkMatch[1]);
    reasoning = r || null;
  } else if (orphanedMatch) {
    const r = sanitizeSegment(orphanedMatch[1]);
    reasoning = r || null;
  }

  let mainContent = processedContent.replace(COT_PAIRED_STRIP_RE, '');

  if (thinkMatch) {
    mainContent = mainContent.replace(COT_CLOSE_STRIP_RE, '');
  } else if (orphanedMatch) {
    mainContent = mainContent.replace(new RegExp(`^[\\s\\S]*?${COT_CLOSE}`, 'g'), '');
  }

  mainContent = sanitizeSegment(mainContent);

  return { reasoning, mainContent, toolCallText };
}

// ---------------------------------------------------------------------------
// Normalization: single entry point for all consumers (rendering, search, etc.)
// ---------------------------------------------------------------------------

/** Normalize an assistant message into consistent reasoning / main / tool-call segments.
 *  Prefers structured content_parts when present, then falls back to parseContent. */
export function normalizeAssistantMessage(message: Message): ParsedContent {
  if (message.role !== 'assistant') {
    return { reasoning: null, mainContent: message.content, toolCallText: null };
  }

  if (message.content_parts && message.content_parts.length > 0) {
    const thinkingParts = message.content_parts
      .filter(p => p.type === 'thinking' && p.thinking)
      .map(p => p.thinking!);
    const textParts = message.content_parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text!);
    return {
      reasoning: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null,
      mainContent: textParts.join('\n'),
      toolCallText: null,
    };
  }

  return parseContent(message.content);
}

// ---------------------------------------------------------------------------
// Field-scoping helpers (shared between rendering and search/counting)
// ---------------------------------------------------------------------------

export function fieldAppliesToContent(field: SearchField, role: string): boolean {
  switch (field) {
    case 'chat':
    case 'all':
      return true;
    case 'system':
      return role === 'system';
    case 'user':
      return role === 'user';
    case 'assistant':
      return role === 'assistant';
    case 'tool':
      return role === 'tool';
    case 'reasoning':
      return false;
    default:
      return false;
  }
}

export function fieldAppliesToReasoning(field: SearchField, role: string): boolean {
  if (role !== 'assistant') return false;
  switch (field) {
    case 'chat':
    case 'all':
    case 'reasoning':
      return true;
    case 'assistant':
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Occurrence counting (matches exactly what MessageCard highlights)
// ---------------------------------------------------------------------------

function countSubstring(text: string, term: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(term, idx)) !== -1) {
    count++;
    idx += term.length;
  }
  return count;
}

/** Count highlight occurrences for a single message, matching the field scoping
 *  and normalized text that MessageCard uses for rendering. */
export function countMessageOccurrences(message: Message, searchConditions: SearchCondition[]): number {
  const activeConditions = searchConditions.filter(c => c.operator === 'contains' && c.term.trim());
  if (activeConditions.length === 0) return 0;

  const { reasoning, mainContent } = normalizeAssistantMessage(message);
  let count = 0;

  for (const condition of activeConditions) {
    const termLower = condition.term.trim().toLowerCase();

    if (fieldAppliesToContent(condition.field, message.role)) {
      count += countSubstring(mainContent.toLowerCase(), termLower);
    }

    if (reasoning && fieldAppliesToReasoning(condition.field, message.role)) {
      count += countSubstring(reasoning.toLowerCase(), termLower);
    }
  }

  return count;
}
