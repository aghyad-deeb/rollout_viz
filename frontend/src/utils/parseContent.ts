// Shared utility for parsing assistant message content into reasoning (CoT) and main content.
// Handles multiple formats:
//   1. <think>...</think>, <reasoning>...</reasoning>, <redacted_thinking>...</redacted_thinking>
//   2. Orphaned </think> or </redacted_thinking> without opening tag (content before it is reasoning)
//   3. GPT-OSS Harmony format: <|channel|>analysis/commentary/final with <|message|>
//   4. Kimi/ChatML format: <|im_assistant|>...<|im_middle|>...<|im_end|> with inline tool calls

import type { Message, SearchCondition, SearchField, ToolCall } from '../types';
import { findAllMatchesCI } from './textMatch';

// --- Harmony regexes ---

const H = '(?:[^<]*(?:<(?!\\|message\\|>)[^<]*)*)';

const HARMONY_ANALYSIS_RE = new RegExp(
  `<\\|channel\\|>analysis(?!\\s+to=functions\\.)${H}<\\|message\\|>([\\s\\S]*?)(?:<\\|end\\|>|<\\|call\\|>)`, 'g'
);
const HARMONY_FINAL_RE = new RegExp(
  `<\\|channel\\|>final${H}<\\|message\\|>([\\s\\S]*?)(?:<\\|return\\|>|<\\|end\\|>|$)`
);
const HARMONY_TOOL_RE = new RegExp(
  `<\\|channel\\|>(analysis|commentary)\\s+to=functions\\.(\\w+)${H}<\\|message\\|>([\\s\\S]*?)(?:<\\|call\\|>|<\\|end\\|>)`, 'g'
);
const HARMONY_STRIP_RE = /<\|(?:start|end|return|call|message|channel|constrain)\|>[^<]*/g;

// --- Compact Harmony format (tags already stripped of <|channel|>/<|message|> markers) ---
// Matches patterns like: "analysisReasoning text.assistantfinalMain content"
// or "analysisThinking.assistantcommentary to=functions.bash json{...}"
function parseCompactHarmony(content: string): { reasoning: string | null; mainContent: string; toolCalls: ToolCall[] } | null {
  if (!content.startsWith('analysis') && !content.startsWith('final') && !content.startsWith('commentary')) {
    return null;
  }

  const reasoningParts: string[] = [];
  let mainContent = '';
  const toolCalls: ToolCall[] = [];

  // "assistantfinal" and "assistantcommentary" are unambiguous (never appear in natural text).
  // "analysis" only at start-of-string. Bare "final"/"commentary" only at start-of-string.
  // We first extract tool calls and final content via the "assistant" prefixed tags,
  // then handle start-of-string bare tags.

  // Extract analysis (reasoning) — always at the start, ends at next "assistant*" or "final"/"commentary" tag or end
  const analysisMatch = content.match(/^analysis([\s\S]*?)(?=assistantfinal|assistantcommentary\s+to=functions\.|$)/);
  if (analysisMatch) {
    const text = analysisMatch[1].trim();
    if (text) reasoningParts.push(text);
  }

  // Extract main content from "assistantfinal" or start-of-string "final"
  const finalMatch = content.match(/(?:^|assistant)final([\s\S]*?)(?=assistantcommentary\s+to=functions\.|$)/);
  if (finalMatch) {
    mainContent = finalMatch[1].trim();
  }

  // Extract tool calls from "assistantcommentary to=functions.X json{...}" or start-of-string "commentary"
  const toolRe = /(?:^|assistant)commentary\s+to=functions\.(\w+)\s*json?([\s\S]*?)(?=analysis|assistantfinal|assistantcommentary\s+to=functions\.|$)/g;
  let toolMatch;
  while ((toolMatch = toolRe.exec(content)) !== null) {
    const fnName = toolMatch[1];
    const args = toolMatch[2].trim();
    toolCalls.push({
      type: 'function',
      function: { name: fnName, arguments: parseToolArguments(args) },
    });
  }

  if (!mainContent && reasoningParts.length === 0 && toolCalls.length === 0) {
    return null;
  }

  return {
    reasoning: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : null,
    mainContent,
    toolCalls,
  };
}

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
  toolCalls: ToolCall[];
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

function formatToolCallText(toolCalls: ToolCall[]): string | null {
  if (toolCalls.length === 0) return null;
  return toolCalls
    .map((toolCall) => {
      const args = typeof toolCall.function.arguments === 'string'
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function.arguments);
      return `[tool call: ${toolCall.function.name}]\n${args}`;
    })
    .join('\n\n');
}

function parseToolArguments(rawArguments: string): ToolCall['function']['arguments'] {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to the raw payload when traces contain malformed JSON.
  }
  return rawArguments;
}

/** Strip ChatML/Kimi wrapper tokens and extract inline tool-call sections. */
function preprocessChatML(content: string): { cleaned: string; toolCalls: ToolCall[] } {
  let cleaned = content;

  // Strip prefix wrappers
  cleaned = cleaned.replace(/^<\|im_assistant\|>\s*assistant\s*<\|im_middle\|>\s*/i, '');
  cleaned = cleaned.replace(/^<\|im_start\|>\s*assistant\s*\n?/i, '');

  // Strip suffix wrappers
  cleaned = cleaned.replace(/<\|im_end\|>\s*$/gi, '');
  cleaned = cleaned.replace(/<\|eot_id\|>\s*$/gi, '');
  cleaned = cleaned.replace(/<\|endoftext\|>\s*$/gi, '');

  // Extract inline Kimi tool calls
  const toolCalls: ToolCall[] = [];
  KIMI_TOOL_SECTION_RE.lastIndex = 0;
  let match;
  while ((match = KIMI_TOOL_SECTION_RE.exec(cleaned)) !== null) {
    const tcContent = match[1];
    const cmdMatch = tcContent.match(KIMI_TOOL_CMD_RE);
    if (cmdMatch) {
      toolCalls.push({
        type: 'function',
        function: {
          name: cmdMatch[1],
          arguments: { command: cmdMatch[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') },
        },
      });
    } else {
      const raw = tcContent.replace(/<\|[^|]+\|>/g, '').trim();
      if (raw) {
        toolCalls.push({
          type: 'function',
          function: {
            name: 'unknown',
            arguments: raw,
          },
        });
      }
    }
  }

  // Remove tool-call sections from cleaned content
  cleaned = cleaned.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, '');

  return {
    cleaned: cleaned.trim(),
    toolCalls,
  };
}

export function parseContent(content: string): ParsedContent {
  // --- Pre-process: strip ChatML/Kimi wrapper tokens ---
  let processedContent = content;
  let toolCalls: ToolCall[] = [];

  if (CHATML_DETECT_RE.test(content)) {
    const result = preprocessChatML(content);
    processedContent = result.cleaned;
    toolCalls = result.toolCalls;
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

    HARMONY_TOOL_RE.lastIndex = 0;
    while ((match = HARMONY_TOOL_RE.exec(processedContent)) !== null) {
      toolCalls.push({
        type: 'function',
        function: {
          name: match[2],
          arguments: parseToolArguments(match[3].trim()),
        },
      });
    }

    if (!mainContent && reasoningParts.length === 0 && toolCalls.length === 0) {
      mainContent = processedContent.replace(HARMONY_STRIP_RE, '').trim();
    }

    return {
      reasoning: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : null,
      mainContent,
      toolCallText: formatToolCallText(toolCalls),
      toolCalls,
    };
  }

  // --- Compact Harmony format (tags already stripped) ---
  const compactResult = parseCompactHarmony(processedContent);
  if (compactResult) {
    return {
      reasoning: compactResult.reasoning,
      mainContent: compactResult.mainContent,
      toolCallText: formatToolCallText(compactResult.toolCalls),
      toolCalls: compactResult.toolCalls,
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

  return { reasoning, mainContent, toolCallText: formatToolCallText(toolCalls), toolCalls };
}

// ---------------------------------------------------------------------------
// Normalization: single entry point for all consumers (rendering, search, etc.)
// ---------------------------------------------------------------------------

/** Normalize an assistant message into consistent reasoning / main / tool-call segments.
 *  Prefers structured content_parts when present, then falls back to parseContent. */
export function normalizeAssistantMessage(message: Message): ParsedContent {
  if (message.role !== 'assistant') {
    return {
      reasoning: null,
      mainContent: message.content,
      toolCallText: null,
      toolCalls: message.tool_calls ?? [],
    };
  }

  // An explicit top-level `reasoning` field (written by producers and by the
  // backend's tinker reconstruction) takes precedence: whatever the branches
  // below extract from content/content_parts is appended after it.
  const fieldReasoning =
    typeof message.reasoning === 'string' && message.reasoning ? message.reasoning : null;
  if (fieldReasoning) {
    const inner = normalizeAssistantMessage({ ...message, reasoning: undefined });
    return {
      ...inner,
      reasoning: inner.reasoning ? `${fieldReasoning}\n\n${inner.reasoning}` : fieldReasoning,
    };
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
      toolCallText: formatToolCallText(message.tool_calls ?? []),
      toolCalls: message.tool_calls ?? [],
    };
  }

  const parsed = parseContent(message.content);
  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      ...parsed,
      toolCallText: formatToolCallText(message.tool_calls),
      toolCalls: message.tool_calls,
    };
  }
  return parsed;
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

function displayToolArguments(args: ToolCall['function']['arguments']): string {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      return parsed?.command != null ? String(parsed.command) : args;
    } catch {
      return args;
    }
  }
  return args?.command != null
    ? String(args.command)
    : JSON.stringify(args, null, 2);
}

function countSubstring(text: string, term: string): number {
  return findAllMatchesCI(text, term).length;
}

/** Count highlight occurrences for a single message, matching the field scoping
 *  and normalized text that MessageCard uses for rendering. */
export function countMessageOccurrences(message: Message, searchConditions: SearchCondition[]): number {
  const activeConditions = searchConditions.filter(c => c.operator === 'contains' && c.term.trim());
  if (activeConditions.length === 0) return 0;

  const { reasoning, mainContent, toolCalls } = normalizeAssistantMessage(message);
  let count = 0;

  for (const condition of activeConditions) {
    const term = condition.term.trim();

    // Match DOM order in MessageCard: reasoning, visible content, then each
    // structured tool-call name and displayed argument payload.
    if (reasoning && fieldAppliesToReasoning(condition.field, message.role)) {
      count += countSubstring(reasoning, term);
    }

    if (fieldAppliesToContent(condition.field, message.role)) {
      count += countSubstring(mainContent, term);
      for (const tc of toolCalls) {
        count += countSubstring(tc.function.name, term);
        count += countSubstring(displayToolArguments(tc.function.arguments), term);
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// In-chat search corpus
// ---------------------------------------------------------------------------

/**
 * Build the searchable string for a single message — what the in-chat
 * Ctrl+F search reads.
 *
 * Why this exists: the previous implementation searched `message.content`
 * directly, which created two symmetric bugs:
 *
 *   1. Displayed-but-not-searchable. Reasoning and main text from
 *      `content_parts[]` (harmony format), and structured tool calls
 *      (`tool_calls[].function.name` / `arguments`), do not appear in
 *      `message.content` and were silently invisible to the search.
 *   2. Searchable-but-not-displayed. ChatML / harmony marker tokens
 *      (`<|im_assistant|>`, `<|channel|>`, `<think>`, the compact-harmony
 *      `analysis` / `assistantfinal` keywords, …) do appear in raw
 *      `message.content` but the renderer strips them, so search
 *      matches landed in invisible text.
 *
 * Routing the search through `normalizeAssistantMessage` solves both:
 * the parser already strips the marker tokens for display, and the
 * structured tool-call list it returns is the same one the card renders.
 *
 * Excluded by design: role label, sample metadata footer, and the grades
 * panel — those are chrome, not message body. Use the global filter-bar
 * search if you need to find them.
 */
/**
 * Format a single message as plain text for clipboard copy. Mirrors what
 * the user sees in the rendered card: reasoning prefixed with a label,
 * main content unwrapped, structured tool calls listed with their
 * function name and (when possible) the parsed `command` field rather
 * than the raw JSON args.
 *
 * Distinct from `buildSearchCorpus`:
 *   - Includes `[Reasoning]` / `[Tool: <name>]` section labels so the
 *     paste destination has context.
 *   - Sections separated by blank lines for readability.
 *   - Strips surrounding whitespace at the edges.
 */
export function formatMessageText(message: Message): string {
  const { reasoning, mainContent, toolCalls } = normalizeAssistantMessage(message);
  const sections: string[] = [];
  if (reasoning && reasoning.trim()) sections.push(`[Reasoning]\n${reasoning}`);
  if (mainContent && mainContent.trim()) sections.push(mainContent);
  for (const tc of toolCalls) {
    // Mirror MessageCard's display rule: when args is a `{command: "..."}`
    // object, show the bare command. Otherwise stringify the full args.
    let args: string;
    try {
      const parsed = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments) as Record<string, unknown>
        : tc.function.arguments;
      if (parsed && typeof parsed === 'object' && parsed.command != null) {
        args = String(parsed.command);
      } else {
        args = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments, null, 2);
      }
    } catch {
      args = typeof tc.function.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function.arguments, null, 2);
    }
    sections.push(`[Tool: ${tc.function.name}]\n${args}`);
  }
  return sections.join('\n\n').trim();
}

export function buildSearchCorpus(message: Message): string {
  const { reasoning, mainContent, toolCalls } = normalizeAssistantMessage(message);
  const parts: string[] = [];
  if (reasoning) parts.push(reasoning);
  if (mainContent) parts.push(mainContent);
  for (const tc of toolCalls) {
    parts.push(`${tc.function.name}\n${displayToolArguments(tc.function.arguments)}`);
  }
  return parts.join('\n');
}
