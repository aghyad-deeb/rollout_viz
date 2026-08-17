import { useState, useRef, useEffect, useCallback } from 'react';
import type { Sample } from '../../types';
import {
  CHAT_MODELS,
  buildSystemPrompt,
  streamRolloutChat,
  loadChatModel,
  saveChatModel,
  type ChatTurn,
} from '../../utils/rolloutChat';
import { ChatMessageCard } from './ChatMessageCard';

interface RolloutChatPanelProps {
  sample: Sample | null;
  isDarkMode: boolean;
  onClose: () => void;
  /**
   * Notified whenever the discussion has content worth preserving — true as
   * soon as there are turns or a stream is in flight, false otherwise.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

// Generic starter questions for the empty state — one click sends them.
const EXAMPLE_QUESTIONS = [
  'Summarize what happened in this rollout',
  'Did the model try to hack the reward?',
  'Explain why it received this reward',
  'What mistakes did the model make?',
];

/**
 * Left-panel content for "discuss this rollout": a chat with a frontier model
 * that has been given the full rollout transcript + grades as context. Replaces
 * the sample table while open. Session-only; resets when the rollout changes.
 *
 * Chat turns render through `ChatMessageCard`, which shares the right-panel
 * MessageCard styling, and the assistant reply streams in token-by-token.
 */
export function RolloutChatPanel({ sample, isDarkMode, onClose, onDirtyChange }: RolloutChatPanelProps) {
  const [model, setModel] = useState<string>(loadChatModel);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // True while the view is pinned near the bottom of the list — only then
  // does streaming auto-scroll. Scrolling up detaches; sending re-sticks.
  const stickToBottomRef = useRef(true);

  // The chat is always about the *currently selected* rollout. App gives this
  // panel a `key` tied to the sample id, so changing rollout remounts it and
  // the conversation resets for free — no reset effect needed.

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Tell the parent when the chat holds state worth a confirm-before-discard.
  // The callback is mirrored into a ref so an unstable prop identity can't
  // retrigger the notify effect (it must fire only when `dirty` flips).
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  const dirty = turns.length > 0 || streaming;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // Keep the newest message in view as it streams — but only while the user
  // is at (or near) the bottom, so scrolling up to re-read isn't fought.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const handleListScroll = () => {
    const el = listRef.current;
    if (el) stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // Drop a trailing assistant turn that never received content or reasoning —
  // used when a stream errors out or is stopped before the first token, so no
  // "(no response)" bubble lingers.
  const dropEmptyTrailingAssistant = useCallback(() => {
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      return last && last.role === 'assistant' && !last.content && !last.reasoning
        ? prev.slice(0, -1)
        : prev;
    });
  }, []);

  // Send a message — `textOverride` lets the empty-state chips fire directly.
  const send = useCallback(
    (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || !sample || streaming) return;
      // Stamp the reply with the *current* model's label at creation so a
      // later picker switch never relabels earlier bubbles.
      const label = CHAT_MODELS.find((m) => m.id === model)?.label ?? 'Model';
      const history: ChatTurn[] = [...turns, { role: 'user', content: text }];
      stickToBottomRef.current = true; // a fresh user message always re-sticks
      setTurns([...history, { role: 'assistant', content: '', model: label }]);
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      setError(null);
      setStreaming(true);

      // Outbound payload is {role, content} only — the model stamp stays
      // client-side, and contentless assistant turns (e.g. reasoning-only
      // aborted replies, still visible in the UI) are never re-sent.
      const messages = [
        { role: 'system', content: buildSystemPrompt(sample) },
        ...history
          .filter((t) => t.role !== 'assistant' || t.content)
          .map((t) => ({ role: t.role, content: t.content })),
      ];
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      streamRolloutChat(
        model,
        messages,
        {
          onText: (delta) =>
            setTurns((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: last.content + delta };
              }
              return next;
            }),
          onReasoning: (delta) =>
            setTurns((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + delta };
              }
              return next;
            }),
          onError: (msg) => {
            setError(msg);
            setStreaming(false);
            abortRef.current = null;
            dropEmptyTrailingAssistant();
          },
          onDone: () => {
            setStreaming(false);
            abortRef.current = null;
          },
        },
        ctrl.signal,
      );
    },
    [input, sample, streaming, turns, model, dropEmptyTrailingAssistant],
  );

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    dropEmptyTrailingAssistant();
  };

  const newChat = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns([]);
    setError(null);
    setStreaming(false);
  };

  // Auto-grow the composer textarea up to a cap as the user types.
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  const panelBg = isDarkMode ? 'bg-[var(--bg-secondary)]' : 'bg-gray-50';
  const barBg = isDarkMode ? 'bg-[var(--bg-tertiary)]' : 'bg-white';
  const border = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const iconBtn = isDarkMode
    ? 'text-gray-300 hover:bg-white/10'
    : 'text-gray-500 hover:bg-gray-200';
  const selectCls = isDarkMode
    ? 'bg-[var(--bg-secondary)] border-gray-600 text-gray-200'
    : 'bg-white border-gray-300 text-gray-700';
  const modelLabel = CHAT_MODELS.find((m) => m.id === model)?.label ?? 'Model';
  const a = sample?.attributes;

  return (
    <div className={`h-full flex flex-col ${panelBg}`}>
      {/* Header */}
      <div className={`border-b ${border} ${barBg}`}>
        <div className="flex items-center gap-2 px-3 py-2">
          <span
            className={`flex items-center justify-center w-7 h-7 rounded-lg ${
              isDarkMode ? 'bg-sky-500/15 text-sky-300' : 'bg-sky-100 text-sky-600'
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              forum
            </span>
          </span>
          <span className={`text-sm font-semibold ${isDarkMode ? 'text-gray-100' : 'text-gray-800'}`}>
            Discuss rollout
          </span>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              saveChatModel(e.target.value);
            }}
            title="Model to chat with"
            className={`ml-auto px-2 py-1 text-xs rounded-md border cursor-pointer ${selectCls}`}
          >
            {CHAT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            onClick={newChat}
            disabled={turns.length === 0 && !streaming}
            title="New chat"
            className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-40 ${iconBtn}`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              restart_alt
            </span>
          </button>
          <button
            onClick={onClose}
            title="Close chat"
            className={`flex items-center justify-center w-7 h-7 rounded-md ${iconBtn}`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              close
            </span>
          </button>
        </div>
        {/* Rollout context — what the model is being asked about. */}
        {a && (
          <div className={`px-3 pb-2 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{a.experiment_name || 'rollout'}</span>
              <span className="shrink-0">· rollout {a.rollout_n}</span>
              <span className="shrink-0">· step {a.step}</span>
              <span className="shrink-0">
                · reward{' '}
                <span
                  className={
                    a.reward >= 0
                      ? isDarkMode
                        ? 'text-green-400'
                        : 'text-green-600'
                      : isDarkMode
                        ? 'text-red-400'
                        : 'text-red-600'
                  }
                >
                  {a.reward}
                </span>
              </span>
            </div>
            <div className={`mt-0.5 truncate ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              Discussion resets when you switch or close this rollout.
            </div>
          </div>
        )}
      </div>

      {/* Message list */}
      <div
        ref={listRef}
        onScroll={handleListScroll}
        data-testid="chat-message-list"
        className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3"
      >
        {!sample ? (
          <div
            className={`h-full flex items-center justify-center text-center text-sm px-6 ${
              isDarkMode ? 'text-gray-500' : 'text-gray-400'
            }`}
          >
            Select a rollout to discuss it.
          </div>
        ) : turns.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <span
              className={`flex items-center justify-center w-14 h-14 rounded-2xl mb-3 ${
                isDarkMode ? 'bg-sky-500/15 text-sky-300' : 'bg-sky-100 text-sky-600'
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 30 }}>
                forum
              </span>
            </span>
            <div className={`text-sm font-semibold mb-1 ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
              Ask anything about this rollout
            </div>
            <div className={`text-xs mb-4 max-w-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {modelLabel} sees the full conversation — reasoning, tool calls, results —
              and every grade.
            </div>
            <div className="flex flex-col gap-1.5 w-full max-w-xs">
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className={`flex items-center gap-2 text-left text-xs px-3 py-2 rounded-lg border transition-colors ${
                    isDarkMode
                      ? 'border-gray-700 bg-gray-800/60 text-gray-300 hover:bg-gray-700/70 hover:border-gray-600'
                      : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:border-gray-300'
                  }`}
                >
                  <span
                    className={`material-symbols-outlined shrink-0 ${
                      isDarkMode ? 'text-sky-400' : 'text-sky-500'
                    }`}
                    style={{ fontSize: 15 }}
                  >
                    arrow_outward
                  </span>
                  <span className="flex-1">{q}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <ChatMessageCard
              key={i}
              role={t.role}
              content={t.content}
              reasoning={t.reasoning}
              isDarkMode={isDarkMode}
              modelLabel={t.model ?? modelLabel}
              isStreaming={streaming && i === turns.length - 1 && t.role === 'assistant'}
            />
          ))
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          className={`mx-3 mb-1 px-3 py-2 text-xs rounded-lg flex items-start gap-1.5 ${
            isDarkMode
              ? 'bg-red-900/40 text-red-300'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          <span className="material-symbols-outlined shrink-0" style={{ fontSize: 14 }}>
            error
          </span>
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            title="Dismiss"
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              close
            </span>
          </button>
        </div>
      )}

      {/* Composer */}
      <div className={`p-3 border-t ${border} ${barBg}`}>
        <div
          className={`flex items-end gap-2 rounded-xl border px-2.5 py-2 transition-colors ${
            isDarkMode
              ? 'bg-[var(--bg-secondary)] border-gray-600 focus-within:border-sky-500'
              : 'bg-white border-gray-300 focus-within:border-sky-400'
          }`}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={sample ? 'Ask about this rollout…' : 'Select a rollout first'}
            disabled={!sample}
            rows={1}
            style={{ maxHeight: 160 }}
            className={`flex-1 resize-none bg-transparent text-sm leading-relaxed focus:outline-none disabled:opacity-50 ${
              isDarkMode ? 'text-gray-200 placeholder-gray-500' : 'text-gray-800 placeholder-gray-400'
            }`}
          />
          {streaming ? (
            <button
              onClick={stop}
              title="Stop"
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-white bg-red-600 hover:bg-red-700 transition-colors"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                stop
              </span>
            </button>
          ) : (
            <button
              onClick={() => send()}
              disabled={!input.trim() || !sample}
              title="Send"
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                arrow_upward
              </span>
            </button>
          )}
        </div>
        <div className={`mt-1.5 text-center text-[11px] ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          Enter to send · Shift+Enter for a new line
        </div>
      </div>
    </div>
  );
}
