import { memo, useState } from 'react';

interface ChatMessageCardProps {
  role: 'user' | 'assistant';
  content: string;
  /** Streamed reasoning/thinking text — shown in its own sub-block. */
  reasoning?: string;
  isDarkMode: boolean;
  /** Display name for the assistant header (the chosen model's label). */
  modelLabel: string;
  /** True while this card is the in-flight streaming reply. */
  isStreaming?: boolean;
}

// Same role styling vocabulary as the right-panel MessageCard — the CSS
// classes (`message-user`, `reasoning`, …) live in index.css and are shared.
const ROLE_CONFIG = {
  user: {
    icon: 'person',
    className: 'message-user',
    headerClassName: 'message-user-header',
    buttonClassName: 'message-user-button',
  },
  assistant: {
    icon: 'network_intelligence',
    className: 'message-assistant',
    headerClassName: 'message-assistant-header',
    buttonClassName: 'message-assistant-button',
  },
} as const;

/**
 * A chat bubble for the "Discuss rollout" panel, styled to match the
 * rollout MessageCards in the right panel — same role colours, header,
 * icons and reasoning sub-block — minus the rollout-specific chrome
 * (share / copy-link / cut / edit). Reasoning and content stream in live,
 * trailed by a blinking caret while the reply is still in flight.
 */
function ChatMessageCardInner({
  role,
  content,
  reasoning,
  isDarkMode,
  modelLabel,
  isStreaming = false,
}: ChatMessageCardProps) {
  const [copied, setCopied] = useState(false);
  const config = ROLE_CONFIG[role];
  const textPrimary = isDarkMode ? 'text-gray-200' : 'text-gray-900';
  const textSecondary = isDarkMode ? 'text-gray-300' : 'text-gray-800';
  const textMuted = isDarkMode ? 'text-gray-400' : 'text-gray-600';
  const name = role === 'user' ? 'You' : modelLabel;

  const copy = () => {
    const text = [reasoning && `[reasoning]\n${reasoning}`, content]
      .filter(Boolean)
      .join('\n\n');
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Blinking caret pinned to the live edge of the streaming text.
  const caret = (
    <span className="inline-block w-1.5 h-3.5 ml-0.5 -mb-px rounded-[2px] bg-current opacity-60 animate-pulse" />
  );

  return (
    <div className={`rounded-lg border-l-4 overflow-hidden shadow-md ${config.className}`}>
      {/* Header — role icon + name, mirroring the right-panel cards. */}
      <div className={`shadow-xs ${config.headerClassName}`}>
        <div className="flex items-center justify-between gap-2 pl-2 pr-1 py-1 min-h-7">
          <span className={`flex items-center gap-1 font-medium text-sm ${textSecondary}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
              {config.icon}
            </span>
            <span>{name}</span>
          </span>
          {role === 'assistant' && content && !isStreaming && (
            <button
              onClick={copy}
              title="Copy message"
              className={`shrink-0 rounded-md w-6 h-6 flex justify-center items-center shadow-md shadow-black/20 ${config.buttonClassName}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                {copied ? 'check' : 'content_copy'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Body — reasoning sub-block + content, both streamed live. */}
      <div className="space-y-3 py-3" style={{ overflowWrap: 'anywhere' }}>
        {reasoning && (
          <div className="mx-3 rounded-md border-l-4 shadow-xs overflow-hidden reasoning">
            <div className={`px-2 py-1 flex items-center gap-1 text-sm font-medium shadow-2xs reasoning-header ${textSecondary}`}>
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                lightbulb
              </span>
              <span>reasoning</span>
            </div>
            <div className={`px-2 py-1 text-sm whitespace-pre-wrap break-words ${textPrimary}`}>
              {reasoning}
              {isStreaming && !content && caret}
            </div>
          </div>
        )}
        {(content || !reasoning) && (
          <div className={`mx-3 text-sm whitespace-pre-wrap break-words ${textPrimary}`}>
            {content ? (
              <>
                {content}
                {isStreaming && caret}
              </>
            ) : isStreaming ? (
              <span className={`${textMuted} animate-pulse`}>Thinking…</span>
            ) : (
              <span className={textMuted}>(no response)</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatMessageCard = memo(ChatMessageCardInner);
