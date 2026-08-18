import type { Message, ToolCall } from '../types';

// Some producers echo the executed command as the first line(s) of the tool
// RESULT, duplicating what the assistant's CALL band already shows. The
// display layer strips that echo (ChatView maps messages through
// stripToolEcho before rendering/searching), keeping the original string in
// raw_content. The underlying JSONL is never modified.

/** The command string carried by one tool call, however the producer shaped it. */
function commandOf(tc: ToolCall): string | null {
  const args = tc.function?.arguments;
  if (typeof args === 'string') return args.trim() || null;
  if (args && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>).command;
    if (typeof cmd === 'string' && cmd.trim()) return cmd.trim();
  }
  return null;
}

/**
 * Strip a leading command echo from a tool result, given the assistant
 * message that issued the call(s). Matching is exact-prefix on the trimmed
 * command followed by a newline (or the whole content equaling the command)
 * — anything less exact risks eating real output.
 */
export function stripToolEcho(
  toolContent: string,
  callingAssistant: Message | undefined,
): { text: string; stripped: boolean } {
  if (!callingAssistant?.tool_calls?.length || typeof toolContent !== 'string' || toolContent === '') {
    return { text: toolContent, stripped: false };
  }
  const content = toolContent;
  for (const tc of callingAssistant.tool_calls) {
    const cmd = commandOf(tc);
    if (!cmd) continue;
    if (content === cmd || content.trimEnd() === cmd) {
      return { text: '', stripped: true };
    }
    if (content.startsWith(cmd)) {
      const rest = content.slice(cmd.length);
      // Only treat it as an echo when the command ends at a line boundary —
      // a result that merely begins with similar text keeps its content.
      if (rest.startsWith('\n')) {
        return { text: rest.replace(/^\n+/, ''), stripped: true };
      }
    }
  }
  return { text: content, stripped: false };
}

/**
 * The assistant message whose tool_calls produced messages[index] (a tool
 * result): scan back past other tool results (parallel calls yield several
 * consecutive tool messages), stop at the first assistant; anything else
 * breaks the chain.
 */
export function callingAssistantFor(messages: Message[], index: number): Message | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') return m.tool_calls?.length ? m : undefined;
    if (m.role !== 'tool') return undefined;
  }
  return undefined;
}

// One mapping result per source array. Sample message arrays are stable
// identities, and this runs inside LeftPanel's `filteredSamples` memo over up
// to 5,000 samples for every condition — recomputing per condition made the
// echo strip the most expensive part of a keystroke. Weak keys, so an
// unloaded sample's arrays are still collectable.
const displayCache = new WeakMap<Message[], Message[]>();

/**
 * THE display mapping for a conversation: the messages as the transcript
 * actually renders them, with tool-result command echoes stripped.
 *
 * Every consumer of message TEXT must go through this — ChatView's rendering
 * and occurrence counting, and LeftPanel's global-search matching and match
 * counts. They disagreed before: the table counted a hit inside an echoed
 * command that the transcript no longer displayed, so the count said "1
 * match" and no mark existed to jump to.
 *
 * Allocation-light by contract: when nothing is stripped (the common case)
 * the ORIGINAL array is returned, not a copy.
 */
export function displayMessages(messages: Message[]): Message[] {
  const cached = displayCache.get(messages);
  if (cached) return cached;

  let stripped: Message[] | null = null;
  messages.forEach((message, index) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return;
    const result = stripToolEcho(message.content, callingAssistantFor(messages, index));
    if (!result.stripped) return;
    if (stripped === null) stripped = [...messages];
    stripped[index] = {
      ...message,
      content: result.text,
      raw_content: message.raw_content ?? message.content,
    };
  });

  const out: Message[] = stripped ?? messages;
  displayCache.set(messages, out);
  return out;
}
