// Rollout-discussion chat — talk to a frontier model about one rollout.
//
// The model is given the full rollout transcript + grades as a system message,
// then the user chats with it normally. Requests are streamed through the
// backend's `/api/rollout-chat-stream` SSE proxy, which forwards to the shared
// `tinker_service` litellm provider.

import type { Sample, Message, ContentPart } from '../types';

export interface ChatModel {
  id: string;
  label: string;
}

// Frontier models, each verified end-to-end against tinker_service's litellm
// provider (non-streaming + SSE). Gemini is routed via OpenRouter because the
// direct Google AI Studio key is currently flagged as leaked.
export const CHAT_MODELS: readonly ChatModel[] = [
  { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'openrouter/google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
];

export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].id;

// localStorage key — remembers the last model the user chatted with.
const MODEL_KEY = 'rollout_viz_chat_model';

export function loadChatModel(): string {
  try {
    const saved = localStorage.getItem(MODEL_KEY);
    if (saved && CHAT_MODELS.some((m) => m.id === saved)) return saved;
  } catch { /* ignore */ }
  return DEFAULT_CHAT_MODEL;
}

export function saveChatModel(id: string): void {
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* ignore */ }
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Streamed reasoning/thinking text — shown live while the answer is pending. */
  reasoning?: string;
}

// Render one message in full — every content-bearing field, format-agnostic.
// The raw `content` string carries inline-encoded reasoning / tool calls
// (Kimi `<think>` / `<tool_call>`, Harmony channels, XML `<bash>`); the
// structured fields carry native-format reasoning / tool calls. Dumping both
// guarantees nothing is dropped, whatever the model family.
function formatMessageForChat(m: Message, index: number): string {
  const head: string[] = [`role: ${m.role}`];
  if (m.name) head.push(`name: ${m.name}`);
  if (m.tool_call_id) head.push(`tool_call_id: ${m.tool_call_id}`);
  const header = `### Message ${index} — ${head.join(', ')}`;

  const sections: string[] = [];

  // Explicit reasoning field (some formats expose reasoning here).
  if (typeof m.reasoning === 'string' && m.reasoning.trim()) {
    sections.push(`[reasoning]\n${m.reasoning}`);
  }

  // Structured multi-channel parts (e.g. Harmony thinking / text channels) —
  // every part is dumped, including unknown shapes.
  if (Array.isArray(m.content_parts)) {
    for (const raw of m.content_parts) {
      const part = (raw ?? {}) as ContentPart;
      const type = String(part.type ?? 'text');
      const channel = part.channel ? `, channel: ${part.channel}` : '';
      const payload =
        (typeof part.thinking === 'string' && part.thinking) ||
        (typeof part.text === 'string' && part.text) ||
        JSON.stringify(part);
      sections.push(`[content part — type: ${type}${channel}]\n${payload}`);
    }
  }

  // The raw content string, verbatim (falls back to raw_content).
  const content =
    (typeof m.content === 'string' && m.content) ||
    (typeof m.raw_content === 'string' && m.raw_content) ||
    '';
  if (content.trim()) sections.push(`[content]\n${content}`);

  // Structured tool calls (OpenAI-style). Arguments dumped whether a JSON
  // string or an object.
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const fn = tc.function;
      const args =
        typeof fn.arguments === 'string'
          ? fn.arguments
          : JSON.stringify(fn.arguments ?? {}, null, 2);
      sections.push(
        `[tool call — name: ${fn.name || '(unnamed)'}${tc.id ? `, id: ${tc.id}` : ''}]\n${args}`,
      );
    }
  }

  if (sections.length === 0) return `${header}\n(empty)`;
  // A plain message (only `content`) needs no inner section labels.
  if (sections.length === 1 && sections[0].startsWith('[content]\n')) {
    return `${header}\n${sections[0].slice('[content]\n'.length)}`;
  }
  return `${header}\n${sections.join('\n\n')}`;
}

// Render a rollout (full transcript + grades) as plain-text reference
// material — the LLM sees the entire chat: reasoning, tool calls, tool
// results, everything, for any model format.
export function formatRolloutForChat(sample: Sample): string {
  const a = sample.attributes;
  const out: string[] = [];
  out.push('# Rollout under discussion');
  out.push(`Experiment: ${a.experiment_name || '(unknown)'}`);
  out.push(
    `rollout_n: ${a.rollout_n} · step: ${a.step} · sample_index: ${a.sample_index}` +
      ` · reward: ${a.reward}`,
  );
  if (a.data_source) out.push(`data_source: ${a.data_source}`);
  out.push('');

  out.push('## Conversation');
  sample.messages.forEach((m, i) => {
    out.push(formatMessageForChat(m, i));
    out.push('');
  });

  const grades = sample.grades ?? {};
  const metrics = Object.keys(grades);
  out.push('## Grades');
  if (metrics.length === 0) {
    out.push('(none)');
  } else {
    for (const metric of metrics) {
      for (const g of grades[metric] ?? []) {
        out.push(`- ${metric}: ${JSON.stringify(g.grade)}  (grader: ${g.model})`);
        if (g.explanation) out.push(`  explanation: ${g.explanation}`);
        for (const q of g.quotes ?? []) {
          out.push(`  quote [message ${q.message_index}]: ${JSON.stringify(q.text)}`);
        }
      }
    }
  }
  return out.join('\n');
}

// The system message: instructions + the rollout as reference material.
export function buildSystemPrompt(sample: Sample): string {
  return [
    'You are a research assistant helping an ML researcher analyze a single',
    'LLM rollout — a conversation trace from a reinforcement-learning or',
    'fine-tuning run. The full rollout and its grades are given below. Answer',
    "the researcher's questions about it — the model's behavior, its",
    'reasoning, the reward, the grades, anything they ask. Be concrete and',
    'quote the trace when it helps.',
    '',
    formatRolloutForChat(sample),
  ].join('\n');
}

export interface ChatStreamHandlers {
  onText: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

// Stream one assistant reply. `messages` is the full list sent to the model
// (system message first, then alternating chat turns). Handlers fire as SSE
// frames arrive; `onDone` or `onError` fires exactly once at the end.
export async function streamRolloutChat(
  model: string,
  messages: { role: string; content: string }[],
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch('/api/rollout-chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    handlers.onError(`Request failed: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    handlers.onError(`Backend error: HTTP ${resp.status}`);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (!data) continue;
        let parsed: { text?: string; message?: string };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (event === 'response.output_text.delta') {
          handlers.onText(parsed.text ?? '');
        } else if (event === 'response.reasoning.delta') {
          handlers.onReasoning?.(parsed.text ?? '');
        } else if (event === 'response.error') {
          handlers.onError(parsed.message ?? 'Unknown error');
          return;
        } else if (event === 'response.done') {
          handlers.onDone();
          return;
        }
      }
    }
    handlers.onDone();
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    handlers.onError(`Stream failed: ${(e as Error).message}`);
  }
}
