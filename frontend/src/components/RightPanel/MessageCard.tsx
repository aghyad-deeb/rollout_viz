import { useState, useMemo, useRef, useEffect, useLayoutEffect, memo, Fragment } from 'react';
import type { Message, ToolCall, SearchCondition, SearchField, Quote, EphemeralHighlight, CollapsedRegion, RegionLocator } from '../../types';
import { normalizeAssistantMessage, fieldAppliesToContent, fieldAppliesToReasoning, formatMessageText } from '../../utils/parseContent';
import { findAllMatches, findAllMatchesCI } from '../../utils/textMatch';
import { PUBLIC_BASE_URL } from '../../config';
import { ElisionPill } from './ElisionPill';

interface MessageCardProps {
  message: Message;
  index: number;
  searchConditions: SearchCondition[]; // Global search conditions
  localSearchTerm?: string; // Local search term for this chat
  isCurrentLocalMatch?: boolean; // Is this message the current local search match
  isDarkMode: boolean;
  rolloutN: number;
  step: number;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; step?: number; index?: number; message?: number; highlight?: string }) => string;
  isHighlighted: boolean;
  highlightedText: string | null;
  onClearHighlight: () => void;
  // For tracking which occurrence is "current" in global search
  messageOccurrenceStart: number; // Starting index of occurrences in this message (0-based global)
  currentOccurrenceIndex: number; // Which occurrence is currently focused
  // Grade quotes to highlight
  gradeQuotes?: Quote[];
  // Share-mode metadata threaded down so message-level / quote-level
  // share-link buttons can mint correct tokens.
  isSharedMode?: boolean;
  shareToken?: string | null;
  selectedIndexInFile?: number;
  // Ephemeral, session-only highlights (full list passed in; this card
  // filters to entries whose messageIndex === index).
  ephemeralHighlights?: EphemeralHighlight[];
  onAddEphemeralHighlight?: (messageIndex: number, text: string, style?: 'highlight' | 'bold' | 'italic', locator?: RegionLocator) => void;
  onRemoveEphemeralHighlight?: (id: string) => void;
  // Presentation Mode: collapse spans into editable `[...]` pills, and
  // capture the card as an image.
  isPresentationMode?: boolean;
  collapsedRegions?: CollapsedRegion[];
  onAddCollapsedRegion?: (messageIndex: number, text: string, locator?: RegionLocator) => void;
  onRemoveCollapsedRegion?: (id: string) => void;
  onUpdateCollapsedRegionLabel?: (id: string, label: string | undefined) => void;
  onHideCollapsedRegion?: (id: string) => void;
  onUpdateCollapsedRegionJoin?: (id: string, side: 'before' | 'after', value: boolean) => void;
  onExpandMessageCollapses?: (messageIndex: number) => void;
  // Per-tool-call soft-wrap state, lifted so the off-screen capture card
  // mirrors it. Keyed `"${messageIndex}:${toolCallIndex}"`.
  wrappedToolCalls?: Set<string>;
  onToggleToolCallWrap?: (messageIndex: number, toolCallIndex: number) => void;
  onCaptureMessage?: (messageIndex: number) => void;
  onPreviewMessage?: (messageIndex: number) => void;
  onPreviewSelect?: (messageIndex: number) => void;
}

const ROLE_CONFIG = {
  system: {
    icon: 'contextual_token',
    className: 'message-system',
    headerClassName: 'message-system-header',
    buttonClassName: 'message-system-button',
  },
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
  tool: {
    icon: 'build',
    className: 'message-tool',
    headerClassName: 'message-tool-header',
    buttonClassName: 'message-tool-button',
  },
  file: {
    icon: 'description',
    className: 'message-file',
    headerClassName: 'message-file-header',
    buttonClassName: 'message-file-button',
  },
  developer: {
    icon: 'code',
    className: 'message-system',
    headerClassName: 'message-system-header',
    buttonClassName: 'message-system-button',
  },
  _gptoss_internal_system: {
    icon: 'contextual_token',
    className: 'message-system',
    headerClassName: 'message-system-header',
    buttonClassName: 'message-system-button',
  },
} as const;

// The text shown for a tool call's arguments: the bare command when the
// args are a {command: "..."} object (the common bash case — full JSON is
// noise), else the raw string / pretty-printed object.
function toolCallArgsText(tc: ToolCall): string {
  if (typeof tc.function.arguments === 'string') {
    try {
      const parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      return parsed?.command != null ? String(parsed.command) : tc.function.arguments;
    } catch {
      return tc.function.arguments;
    }
  }
  return tc.function.arguments?.command != null
    ? String(tc.function.arguments.command)
    : JSON.stringify(tc.function.arguments, null, 2);
}

// Stable empty default for the wrappedToolCalls prop (avoids allocating a
// new Set on every render when the prop is omitted).
const EMPTY_WRAP_SET = new Set<string>();

interface SelectionPopup {
  show: boolean;
  x: number;
  y: number;
  text: string;
  // The text of the containing block before / after the selection — used
  // by "Isolate" to collapse everything around the selection.
  before: string;
  after: string;
  // Which renderable block the selection sits in, so "Isolate" can collapse
  // every *other* block whole. '' when the selection isn't inside a known
  // block; blockIndex is the tool-call index when blockKind === 'tool'.
  blockKind: '' | 'reasoning' | 'content' | 'tool';
  blockIndex: number;
}

type RenderBlockKind = 'reasoning' | 'content' | 'tool';

type TextMarkKind =
  | 'url'
  | 'ephemeral-highlight'
  | 'ephemeral-bold'
  | 'ephemeral-italic'
  | 'grade-quote'
  | 'local-search'
  | 'global-search';

interface TextMarkRange {
  start: number;
  end: number;
  kind: TextMarkKind;
  sourceId?: string;
  isCurrent?: boolean;
}

function MessageCardInner({
  message,
  index,
  searchConditions,
  localSearchTerm = '',
  isCurrentLocalMatch = false,
  isDarkMode,
  rolloutN,
  step,
  filePath,
  generateLink,
  isHighlighted,
  highlightedText,
  onClearHighlight,
  messageOccurrenceStart,
  currentOccurrenceIndex,
  gradeQuotes = [],
  isSharedMode = false,
  shareToken,
  selectedIndexInFile,
  ephemeralHighlights = [],
  onAddEphemeralHighlight,
  onRemoveEphemeralHighlight,
  isPresentationMode = false,
  collapsedRegions = [],
  onAddCollapsedRegion,
  onRemoveCollapsedRegion,
  onUpdateCollapsedRegionLabel,
  onHideCollapsedRegion,
  onUpdateCollapsedRegionJoin,
  onExpandMessageCollapses,
  wrappedToolCalls = EMPTY_WRAP_SET,
  onToggleToolCallWrap,
  onCaptureMessage,
  onPreviewMessage,
  onPreviewSelect,
}: MessageCardProps) {
  void isSharedMode;
  const [isExpanded, setIsExpanded] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopup>({ show: false, x: 0, y: 0, text: '', before: '', after: '', blockKind: '', blockIndex: -1 });
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedSelection, setCopiedSelection] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [sharedMsg, setSharedMsg] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const config = ROLE_CONFIG[message.role] || ROLE_CONFIG.user;

  // Smooth-scroll the card into view when it becomes the URL-shared target.
  useEffect(() => {
    if (isHighlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isHighlighted]);

  // Clamp the selection popup horizontally so it can't slide under the left
  // panel when the selection is near the card's left edge. The popup is
  // centered on the selection (`-translate-x-1/2`); measured after it mounts
  // and its center pinned so the whole popup stays inside the card.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const card = cardRef.current;
    if (!selectionPopup.show || !popup || !card) return;
    const margin = 8;
    const half = popup.offsetWidth / 2;
    const cardW = card.offsetWidth;
    const min = margin + half;
    const max = Math.max(min, cardW - margin - half);
    popup.style.left = `${Math.max(min, Math.min(max, selectionPopup.x))}px`;
  }, [selectionPopup.show, selectionPopup.x]);

  // Show the selection action popup when the user finishes a text selection
  // inside this card. Listens on `document` (not the content element) so a
  // mouse-up that lands outside the text - common when dragging across
  // several lines - still registers.
  useEffect(() => {
    const onDocMouseUp = (e: MouseEvent) => {
      // Ignore mouse-ups on the popup itself (e.g. clicking its buttons).
      if ((e.target as Element | null)?.closest?.('.selection-popup')) return;
      const content = contentRef.current;
      const card = cardRef.current;
      if (!content || !card) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const selectedText = selection.toString().trim();
      if (!selectedText) {
        setSelectionPopup((prev) => (prev.show ? { ...prev, show: false } : prev));
        return;
      }
      const range = selection.getRangeAt(0);
      // Both ends of the selection must lie inside this card's content.
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) {
        return;
      }
      // Compute the before/after text within the containing renderable block
      // (a `[data-msg-block]` ancestor) so "Isolate" can collapse around the
      // selection. Best-effort: on a block that already has collapse pills
      // these strings include `[...]` and isolate degrades gracefully.
      let before = '';
      let after = '';
      let blockKind: SelectionPopup['blockKind'] = '';
      let blockIndex = -1;
      const anchorEl = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
      const block = anchorEl?.closest('[data-msg-block]');
      if (block) {
        const kind = block.getAttribute('data-block-kind');
        if (kind === 'reasoning' || kind === 'content' || kind === 'tool') blockKind = kind;
        const bi = block.getAttribute('data-block-index');
        if (bi != null) blockIndex = Number(bi);
        try {
          const br = document.createRange();
          br.selectNodeContents(block);
          br.setEnd(range.startContainer, range.startOffset);
          before = br.toString();
          const ar = document.createRange();
          ar.selectNodeContents(block);
          ar.setStart(range.endContainer, range.endOffset);
          after = ar.toString();
        } catch { /* ignore - isolate just won't have flanks */ }
      }
      const rect = range.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      setSelectionPopup({
        show: true,
        x: rect.left + rect.width / 2 - cardRect.left,
        y: rect.top - cardRect.top - 10,
        text: selectedText,
        before,
        after,
        blockKind,
        blockIndex,
      });
    };
    document.addEventListener('mouseup', onDocMouseUp);
    return () => document.removeEventListener('mouseup', onDocMouseUp);
  }, []);

  // Hide popup when clicking elsewhere.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (selectionPopup.show) {
        const target = e.target as HTMLElement;
        if (!target.closest('.selection-popup')) {
          setSelectionPopup(prev => ({ ...prev, show: false }));
        }
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selectionPopup.show]);

  // --- Presentation Mode actions ---
  const closePopup = () => {
    setSelectionPopup(prev => ({ ...prev, show: false }));
    window.getSelection()?.removeAllRanges();
  };
  // Source text of one of the message's renderable blocks.
  const blockSourceText = (kind: string, blockIdx: number): string => {
    const p = normalizeAssistantMessage(message);
    if (kind === 'reasoning') return p.reasoning ?? '';
    if (kind === 'content') return p.mainContent ?? '';
    if (kind === 'tool') return p.toolCalls[blockIdx] ? toolCallArgsText(p.toolCalls[blockIdx]) : '';
    return '';
  };
  // Pin a selection to the exact occurrence the user picked, so the same
  // string elsewhere in the message isn't collapsed / highlighted too. The
  // occurrence is the block match closest to the selection's rendered offset
  // (exact when the block has no earlier pills shifting that offset).
  const selectionLocator = (): RegionLocator | undefined => {
    const { blockKind, blockIndex, before, text } = selectionPopup;
    if (!blockKind || !text) return undefined;
    const ms = findAllMatches(blockSourceText(blockKind, blockIndex), text);
    if (ms.length === 0) return undefined;
    let occurrence = 0;
    let bestDist = Infinity;
    ms.forEach((m, i) => {
      const dist = Math.abs(m.start - before.length);
      if (dist < bestDist) { bestDist = dist; occurrence = i; }
    });
    return {
      blockKind,
      blockIndex: blockKind === 'tool' ? blockIndex : undefined,
      occurrence,
    };
  };
  // Apply an ephemeral text style (highlight / bold / italic) to the
  // current selection, then dismiss the popup.
  const applyFormat = (style: 'highlight' | 'bold' | 'italic') => {
    if (selectionPopup.text) {
      onAddEphemeralHighlight?.(index, selectionPopup.text, style, selectionLocator());
    }
    closePopup();
  };
  // Collapse the selection into a `[...]` pill.
  const doCollapse = () => {
    if (selectionPopup.text) {
      onAddCollapsedRegion?.(index, selectionPopup.text, selectionLocator());
    }
    closePopup();
  };
  // Isolate: keep only the selection visible. The flanking text within the
  // selection's own block is collapsed (each flank a `[...]` pill), and
  // every *other* renderable block of the message — reasoning, main
  // content, each tool call — is collapsed whole. So isolating from the
  // main content also collapses the bash output and the reasoning, and
  // vice versa. Skipped when the selection isn't inside a recognized
  // block, so isolate can never nuke the entire message.
  const doIsolate = () => {
    const before = selectionPopup.before.trim();
    const after = selectionPopup.after.trim();
    if (before) onAddCollapsedRegion?.(index, before);
    if (after) onAddCollapsedRegion?.(index, after);
    const { blockKind, blockIndex } = selectionPopup;
    if (blockKind) {
      const parsed = normalizeAssistantMessage(message);
      const collapseWhole = (t: string | null | undefined) => {
        if (!t || !t.trim()) return;
        const already = collapsedRegions.some(
          (r) => r.messageIndex === index && r.text === t,
        );
        if (!already) onAddCollapsedRegion?.(index, t);
      };
      if (blockKind !== 'reasoning') collapseWhole(parsed.reasoning);
      if (blockKind !== 'content') collapseWhole(parsed.mainContent);
      parsed.toolCalls.forEach((tc, i) => {
        if (blockKind === 'tool' && i === blockIndex) return;
        collapseWhole(toolCallArgsText(tc));
      });
    }
    closePopup();
  };
  const captureThisCard = () => onCaptureMessage?.(index);
  const previewThisCard = () => onPreviewMessage?.(index);

  // Keyboard shortcuts (presentation mode only), while a selection popup is
  // open: `c` collapse, `o` (or `Shift+C`) isolate, `h` highlight, `b` bold,
  // `i` italic. `p` captures the hovered card.
  useEffect(() => {
    if (!isPresentationMode) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'c' && selectionPopup.show) {
        e.preventDefault();
        if (e.shiftKey) doIsolate(); else doCollapse();
      } else if (k === 'o' && selectionPopup.show) {
        e.preventDefault();
        doIsolate();
      } else if (k === 'h' && selectionPopup.show) {
        e.preventDefault();
        applyFormat('highlight');
      } else if (k === 'b' && selectionPopup.show) {
        e.preventDefault();
        applyFormat('bold');
      } else if (k === 'i' && selectionPopup.show) {
        e.preventDefault();
        applyFormat('italic');
      } else if (k === 'p' && !e.shiftKey && isHovered) {
        e.preventDefault();
        captureThisCard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresentationMode, selectionPopup.show, selectionPopup.text, selectionPopup.before, selectionPopup.after, selectionPopup.blockKind, selectionPopup.blockIndex, isHovered, index]);

  const getApplicableSearchTerms = useMemo(() => {
    return (isReasoning: boolean): string[] => {
      return searchConditions
        .filter(c => c.operator === 'contains' && c.term.trim())
        .filter(c => isReasoning
          ? fieldAppliesToReasoning(c.field, message.role)
          : fieldAppliesToContent(c.field, message.role))
        .map(c => c.term.trim());
    };
  }, [searchConditions, message.role]);

  // Use the *normalized* tool calls (Kimi/Harmony parsers extract them
  // into this field) so structured rendering works even when the producer
  // wrote inline tool tags rather than message.tool_calls.
  const { reasoning, mainContent, toolCallText, toolCalls } = useMemo(
    () => normalizeAssistantMessage(message),
    // normalizeAssistantMessage reads only these four fields of `message`;
    // listing them (not `message`) avoids recompute on unrelated identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.role, message.content, message.content_parts, message.tool_calls],
  );

  const countGlobalSearchMatches = (text: string, isReasoning: boolean): number => {
    let count = 0;
    for (const term of getApplicableSearchTerms(isReasoning)) {
      count += findAllMatchesCI(text, term).length;
    }
    return count;
  };

  const globalOccurrenceStarts = useMemo(() => {
    const toolNameStarts: number[] = [];
    const toolArgStarts: number[] = [];
    let cursor = messageOccurrenceStart;
    const reasoningStart = cursor;
    if (reasoning) cursor += countGlobalSearchMatches(reasoning, true);
    const contentStart = cursor;
    cursor += countGlobalSearchMatches(mainContent, false);
    toolCalls.forEach((tc) => {
      toolNameStarts.push(cursor);
      cursor += countGlobalSearchMatches(tc.function.name, false);
      toolArgStarts.push(cursor);
      cursor += countGlobalSearchMatches(toolCallArgsText(tc), false);
    });
    return { reasoningStart, contentStart, toolNameStarts, toolArgStarts };
    // countGlobalSearchMatches depends on getApplicableSearchTerms, which is
    // already covered here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageOccurrenceStart, reasoning, mainContent, toolCalls, getApplicableSearchTerms]);

  // Highlight compositor. Every strategy contributes ranges, then one
  // renderer splits the original text at all range boundaries and applies
  // every active mark to each segment. Target classes are attached only to
  // the first segment of a logical range so scroll-to-quote/search still sees
  // one target per match even when another mark cuts across it.
  const highlightSearchAndUrl = useMemo(() => {
    const quoteAppliesToRenderedBlock = (
      quote: Quote,
      isReasoningBlock: boolean,
      blockKind?: RenderBlockKind,
    ): boolean => {
      const channel = quote.channel ?? 'text';
      if (channel === 'thinking' || channel === 'reasoning_summary') {
        return isReasoningBlock || blockKind === 'reasoning';
      }
      if (channel === 'tool_call') return blockKind === 'tool';
      if (channel === 'tool_result') {
        return message.role === 'tool' && blockKind === 'content';
      }
      return !isReasoningBlock && blockKind !== 'tool';
    };

    return (
      text: string,
      isReasoning: boolean = false,
      blockKind?: RenderBlockKind,
      blockIndex = -1,
      occurrenceStart = messageOccurrenceStart,
    ): React.ReactNode => {
      if (!text) return text;

      const ranges: TextMarkRange[] = [];
      const addRange = (
        kind: TextMarkKind,
        start: number,
        end: number,
        options: Pick<TextMarkRange, 'sourceId' | 'isCurrent'> = {},
      ) => {
        const boundedStart = Math.max(0, Math.min(text.length, start));
        const boundedEnd = Math.max(0, Math.min(text.length, end));
        if (boundedStart >= boundedEnd) return;
        ranges.push({
          start: boundedStart,
          end: boundedEnd,
          kind,
          ...options,
        });
      };

      if (highlightedText) {
        for (const m of findAllMatches(text, highlightedText)) {
          addRange('url', m.start, m.end);
        }
      }

      const forThisMessage = ephemeralHighlights.filter(h => h.messageIndex === index);
      for (const h of forThisMessage) {
        const matches = findAllMatches(text, h.text);
        const loc = h.locator;
        const style = h.style ?? 'highlight';
        const kind: TextMarkKind = style === 'bold'
          ? 'ephemeral-bold'
          : style === 'italic'
            ? 'ephemeral-italic'
            : 'ephemeral-highlight';
        if (loc) {
          if (!blockKind || loc.blockKind !== blockKind) continue;
          if (loc.blockKind === 'tool' && loc.blockIndex !== blockIndex) continue;
          const m = matches[loc.occurrence];
          if (m) addRange(kind, m.start, m.end, { sourceId: h.id });
        } else {
          for (const m of matches) {
            addRange(kind, m.start, m.end, { sourceId: h.id });
          }
        }
      }

      const quotesForThisMessage = gradeQuotes.filter(q =>
        q.message_index === index && quoteAppliesToRenderedBlock(q, isReasoning, blockKind)
      );
      for (const quote of quotesForThisMessage) {
        for (const m of findAllMatches(text, quote.text)) {
          addRange('grade-quote', m.start, m.end);
        }
      }

      if (localSearchTerm.trim() !== '') {
        for (const m of findAllMatchesCI(text, localSearchTerm)) {
          addRange('local-search', m.start, m.end, { isCurrent: isCurrentLocalMatch });
        }
      }

      const globalMatches: Array<{ start: number; end: number }> = [];
      for (const term of getApplicableSearchTerms(isReasoning)) {
        for (const m of findAllMatchesCI(text, term)) {
          globalMatches.push({ start: m.start, end: m.end });
        }
      }
      globalMatches.sort((a, b) => a.start - b.start || a.end - b.end);
      globalMatches.forEach((m, occurrenceIdx) => {
        const globalIdx = occurrenceStart + occurrenceIdx;
        addRange('global-search', m.start, m.end, { isCurrent: globalIdx === currentOccurrenceIndex });
      });

      if (ranges.length === 0) return text;

      const renderMarkedSegment = (
        segment: string,
        active: TextMarkRange[],
        segmentStart: number,
        key: string,
      ): React.ReactNode => {
        const hasKind = (kind: TextMarkKind) => active.some(r => r.kind === kind);
        const startsKind = (kind: TextMarkKind) => active.some(r => r.kind === kind && r.start === segmentStart);
        const isCurrentKind = (kind: TextMarkKind) => active.some(r => r.kind === kind && r.isCurrent);
        const ephemeralIds = Array.from(new Set(
          active
            .filter(r => r.kind.startsWith('ephemeral-') && r.sourceId)
            .map(r => r.sourceId as string)
        ));
        const hasAction = hasKind('url') || ephemeralIds.length > 0;
        const onClick = hasAction
          ? (e: React.MouseEvent) => {
              e.stopPropagation();
              if (hasKind('url')) onClearHighlight();
              ephemeralIds.forEach(id => onRemoveEphemeralHighlight?.(id));
            }
          : undefined;

        let node: React.ReactNode = segment;
        const formatTitle = ephemeralIds.length > 0 ? 'Click to remove formatting' : undefined;
        const formatCursor = ephemeralIds.length > 0 ? 'cursor-pointer' : '';
        if (hasKind('ephemeral-bold')) {
          node = (
            <strong
              key={`${key}-bold`}
              className={`ephemeral-bold-mark font-bold ${formatCursor}`}
              onClick={onClick}
              title={formatTitle}
            >
              {node}
            </strong>
          );
        }
        if (hasKind('ephemeral-italic')) {
          node = (
            <em
              key={`${key}-italic`}
              className={`ephemeral-italic-mark italic ${formatCursor}`}
              onClick={onClick}
              title={formatTitle}
            >
              {node}
            </em>
          );
        }

        const hasVisual = hasKind('url')
          || hasKind('ephemeral-highlight')
          || hasKind('grade-quote')
          || hasKind('local-search')
          || hasKind('global-search');

        if (!hasVisual) return node;

        const classes = ['px-0.5', 'rounded'];
        const titles: string[] = [];
        if (hasKind('url')) {
          classes.push(
            startsKind('url') ? 'url-highlight-mark' : 'url-highlight-fragment',
            'bg-blue-100', 'dark:bg-blue-500/25', 'text-inherit', 'underline',
            'decoration-blue-500', 'dark:decoration-blue-400', 'decoration-2', 'underline-offset-2'
          );
          titles.push('Click to clear highlight');
        }
        if (hasKind('grade-quote')) {
          classes.push(
            startsKind('grade-quote') ? 'grade-quote-mark' : 'grade-quote-fragment',
            'bg-purple-200', 'dark:bg-purple-900/50', 'text-purple-900',
            'dark:text-purple-200', 'border-b-2', 'border-purple-400'
          );
          titles.push('Quoted by LLM grader');
        }
        if (hasKind('local-search')) {
          classes.push(
            startsKind('local-search') ? 'local-search-mark' : 'local-search-fragment',
            ...(isCurrentKind('local-search')
              ? ['bg-green-400', 'text-green-900']
              : ['bg-green-200', 'text-green-800'])
          );
        }
        if (hasKind('global-search')) {
          classes.push(
            startsKind('global-search') ? 'global-search-highlight' : 'global-search-highlight-fragment',
            ...(isCurrentKind('global-search')
              ? ['bg-orange-400', 'text-orange-950', 'ring-2', 'ring-orange-500', 'ring-offset-1']
              : ['bg-yellow-300', 'text-yellow-900'])
          );
        }
        if (hasKind('ephemeral-highlight')) {
          classes.push(
            startsKind('ephemeral-highlight') ? 'ephemeral-highlight-mark' : 'ephemeral-highlight-fragment',
            'bg-fuchsia-300', 'dark:bg-fuchsia-500/40', 'text-inherit',
            'transition-colors', 'hover:bg-fuchsia-400', 'dark:hover:bg-fuchsia-500/60'
          );
          titles.push('Click to remove highlight');
        }
        if (hasAction) classes.push('cursor-pointer');

        return (
          <mark
            key={key}
            className={classes.join(' ')}
            onClick={onClick}
            title={titles.length > 0 ? Array.from(new Set(titles)).join('; ') : undefined}
          >
            {node}
          </mark>
        );
      };

      const boundaries = new Set<number>([0, text.length]);
      for (const range of ranges) {
        boundaries.add(range.start);
        boundaries.add(range.end);
      }
      const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);
      const parts: React.ReactNode[] = [];
      for (let i = 0; i < sortedBoundaries.length - 1; i++) {
        const start = sortedBoundaries[i];
        const end = sortedBoundaries[i + 1];
        if (start === end) continue;
        const segment = text.slice(start, end);
        const active = ranges.filter(range => range.start < end && range.end > start);
        parts.push(active.length > 0
          ? renderMarkedSegment(segment, active, start, `mark-${start}-${end}-${i}`)
          : segment
        );
      }
      return parts;
    };
  }, [
    getApplicableSearchTerms, localSearchTerm, isCurrentLocalMatch,
    highlightedText, onClearHighlight, messageOccurrenceStart, currentOccurrenceIndex,
    gradeQuotes, index, ephemeralHighlights, onRemoveEphemeralHighlight, message.role,
  ]);

  // True when an entire section's text is collapsed by a single region —
  // lets the section drop its card chrome (header + border) and render as
  // just the `[...]` pill.
  const isSectionCollapsed = (sectionText: string): boolean =>
    isPresentationMode &&
    collapsedRegions.some((r) => r.messageIndex === index && r.text === sectionText);

  // True when this message has any collapsed region — gates the per-message
  // "expand all" button, the recovery path for hidden ellipses.
  const messageHasCollapses = collapsedRegions.some((r) => r.messageIndex === index);

  // Outer pass: replace collapsed spans with `<ElisionPill>`, recursing the
  // rest of the text through the highlight cascade. Active only in
  // Presentation Mode; the cascade is otherwise untouched.
  //
  // Pills are joined to the surrounding text on both sides by default — a
  // collapsed span sits inline with the line before and the line after.
  // Each pill's right-click menu can override a side; an explicit `false`
  // breaks the pill onto its own line.
  const renderWithCollapse = (
    text: string,
    isReasoning: boolean,
    blockKind: RenderBlockKind,
    blockIndex = -1,
    occurrenceStart = messageOccurrenceStart,
  ): React.ReactNode => {
    if (!isPresentationMode || collapsedRegions.length === 0) {
      return highlightSearchAndUrl(text, isReasoning, blockKind, blockIndex, occurrenceStart);
    }
    const regionsForThis = collapsedRegions.filter(r => r.messageIndex === index);
    if (regionsForThis.length === 0) return highlightSearchAndUrl(text, isReasoning, blockKind, blockIndex, occurrenceStart);

    const found: { start: number; end: number; region: CollapsedRegion }[] = [];
    for (const region of regionsForThis) {
      const ms = findAllMatches(text, region.text);
      const loc = region.locator;
      if (loc) {
        // Scoped to one occurrence in one block — the same string elsewhere
        // in the message is left alone.
        if (loc.blockKind !== blockKind) continue;
        if (loc.blockKind === 'tool' && loc.blockIndex !== blockIndex) continue;
        const m = ms[loc.occurrence];
        if (m) found.push({ start: m.start, end: m.end, region });
      } else {
        // Unlocated (whole-section / isolate collapse) — its text is unique.
        for (const m of ms) found.push({ start: m.start, end: m.end, region });
      }
    }
    if (found.length === 0) return highlightSearchAndUrl(text, isReasoning, blockKind, blockIndex, occurrenceStart);
    found.sort((a, b) => a.start - b.start);

    // Drop overlapping matches → a clean, ordered list of pills.
    const pills: { start: number; end: number; region: CollapsedRegion }[] = [];
    let cursor = 0;
    for (const m of found) {
      if (m.start < cursor) continue;
      pills.push(m);
      cursor = m.end;
    }

    // Text segments around the pills: gaps[i] precedes pills[i],
    // gaps[pills.length] is the trailing text.
    const gaps: string[] = [];
    for (let i = 0; i <= pills.length; i++) {
      const s = i === 0 ? 0 : pills[i - 1].end;
      const e = i === pills.length ? text.length : pills[i].start;
      gaps.push(text.slice(s, e));
    }

    // Normalize the whitespace where a gap meets a pill, per the pill's
    // explicit join overrides. undefined → leave the source verbatim;
    // true → drop the boundary newline (pill shares the line); false →
    // force exactly one boundary newline (pill on its own line).
    const joinGap = (g: string, leftAfter: boolean | undefined, rightBefore: boolean | undefined): string => {
      let out = g;
      if (rightBefore === true) out = out.replace(/\s*\n\s*$/, ' ');
      else if (rightBefore === false) out = out.replace(/\s*$/, '\n');
      if (leftAfter === true) out = out.replace(/^\s*\n\s*/, ' ');
      else if (leftAfter === false) out = out.replace(/^\s*/, '\n');
      return out;
    };

    const parts: React.ReactNode[] = [];
    let visibleOccurrenceStart = occurrenceStart;
    for (let i = 0; i <= pills.length; i++) {
      // A pill defaults to joined (inline) on each side; `undefined` here
      // means there's simply no pill on that side (a document end), which
      // joinGap leaves verbatim.
      const leftAfter = i === 0 ? undefined : (pills[i - 1].region.joinAfter ?? true);
      const rightBefore = i === pills.length ? undefined : (pills[i].region.joinBefore ?? true);
      const gap = joinGap(gaps[i], leftAfter, rightBefore);
      if (gap) {
        parts.push(
          <Fragment key={`vis-${i}`}>{highlightSearchAndUrl(gap, isReasoning, blockKind, blockIndex, visibleOccurrenceStart)}</Fragment>
        );
        visibleOccurrenceStart += countGlobalSearchMatches(gap, isReasoning);
      }
      if (i < pills.length) {
        const p = pills[i];
        if (!p.region.hidden) {
          // Effective join state for the menu ticks — joined unless the
          // user explicitly broke that side.
          const effJoinBefore = p.region.joinBefore ?? true;
          const effJoinAfter = p.region.joinAfter ?? true;
          parts.push(
            <ElisionPill
              key={`pill-${p.region.id}-${p.start}`}
              text={p.region.text}
              label={p.region.label}
              isDarkMode={isDarkMode}
              joinBefore={effJoinBefore}
              joinAfter={effJoinAfter}
              onChangeLabel={(label) => onUpdateCollapsedRegionLabel?.(p.region.id, label)}
              onRemove={() => onRemoveCollapsedRegion?.(p.region.id)}
              onHide={() => onHideCollapsedRegion?.(p.region.id)}
              onToggleJoinBefore={() => onUpdateCollapsedRegionJoin?.(p.region.id, 'before', !effJoinBefore)}
              onToggleJoinAfter={() => onUpdateCollapsedRegionJoin?.(p.region.id, 'after', !effJoinAfter)}
            />
          );
        }
      }
    }
    return parts;
  };

  // Copy a plain-text rendition of this message's body (reasoning labeled,
  // tool calls labeled, ChatML markers stripped) for pasting into docs /
  // chat. Distinct from the "Copy link" button (which copies a URL) and
  // from the chat-level "Copy conversation" (which copies all messages).
  const copyMessageText = () => {
    const text = formatMessageText(message);
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  const copyMessageLink = () => {
    const link = generateLink({
      file: filePath,
      rollout: rolloutN,
      step,
      index: selectedIndexInFile,
      message: index,
    });
    navigator.clipboard.writeText(link);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const copySelectionLink = () => {
    const link = generateLink({
      file: filePath,
      rollout: rolloutN,
      step,
      index: selectedIndexInFile,
      message: index,
      highlight: selectionPopup.text,
    });
    navigator.clipboard.writeText(link);
    setCopiedSelection(true);
    setTimeout(() => {
      setCopiedSelection(false);
      setSelectionPopup(prev => ({ ...prev, show: false }));
    }, 1500);
  };

  // Mint a share token (or reuse one in scope) and copy a token-based URL
  // to this specific message. Recipient doesn't need to log in.
  const shareMessage = async () => {
    try {
      let token = shareToken;
      if (!token) {
        const res = await fetch('/api/share/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: filePath,
            rollout: rolloutN,
            step,
            // Authoritative disambiguator — without it, two samples sharing
            // (rollout, step) would point the recipient at whichever one
            // came first in the file rather than the one we shared from.
            index: selectedIndexInFile,
          }),
        });
        if (!res.ok) return;
        const data = await res.json();
        token = data.token;
      }
      if (token) {
        const params = new URLSearchParams({ share: token, message: index.toString() });
        const url = `${PUBLIC_BASE_URL}/?${params.toString()}`;
        navigator.clipboard.writeText(url);
        setSharedMsg(true);
        setTimeout(() => setSharedMsg(false), 2000);
      }
    } catch { /* ignore */ }
  };

  const textPrimary = isDarkMode ? 'text-gray-200' : 'text-gray-900';
  const textSecondary = isDarkMode ? 'text-gray-300' : 'text-gray-800';
  const textMuted = isDarkMode ? 'text-gray-400' : 'text-gray-600';
  const actionBtn = `rounded-md w-6 h-6 focus:outline-none focus:ring-4 flex justify-center items-center ${config.buttonClassName} shadow-md shadow-black/20`;
  const presentationLabel = typeof message.presentationLabel === 'string'
    ? message.presentationLabel.trim()
    : '';
  const fileLabel = message.role === 'file' && typeof message.name === 'string'
    ? message.name.trim()
    : '';
  const headerLabel = presentationLabel || fileLabel || message.role;

  return (
    <div
      ref={cardRef}
      className={`transition-all duration-200 relative ${isHighlighted ? 'ring-2 ring-blue-500 ring-offset-2 rounded-lg' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={() => { if (isPresentationMode) onPreviewSelect?.(index); }}
    >
      <div className="relative">
        <div className={`rounded-lg border-l-4 overflow-hidden transition-all duration-200 ${config.className} shadow-md`}>
          {/* Header */}
          <div className={`shadow-xs ${config.headerClassName}`}>
            <div
              className={`flex items-center justify-between pl-2 pr-1 py-1 cursor-pointer transition-colors duration-150 ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-gray-50/50'}`}
              onClick={() => setIsExpanded(!isExpanded)}
            >
              <div className="flex items-center gap-2">
                <button className="presentation-chrome">
                  <span
                    className={`material-symbols-outlined ${textMuted} transition-transform duration-200 p-2 -m-2 ${isExpanded ? '' : '-rotate-90'}`}
                    style={{ fontSize: 17 }}
                  >
                    expand_less
                  </span>
                </button>
                <span className={`font-medium text-sm ${textSecondary}`}>
                  {/* min-h (not fixed h) so in the scaled-up capture the
                      header grows with the enlarged icon/label instead of
                      staying cramped. On screen the content is 20px tall, so
                      min-h-5 renders identically to the old h-5. */}
                  <span className="flex items-center min-h-5 gap-1">
                    <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                      {config.icon}
                    </span>
                    {headerLabel}
                  </span>
                </span>
              </div>
              {/* Action buttons — entirely presentation-chrome (excluded
                  from a captured image). */}
              <div className="flex items-center gap-1 presentation-chrome">
                {isPresentationMode && messageHasCollapses && (
                  <button
                    data-testid="expand-message-btn"
                    className={actionBtn}
                    title="Expand all collapsed spans in this message"
                    onClick={(e) => { e.stopPropagation(); onExpandMessageCollapses?.(index); }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>unfold_more</span>
                  </button>
                )}
                {isPresentationMode && (
                  <button
                    data-testid="preview-message-btn"
                    className={`${actionBtn} transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}
                    title="Preview the capture image"
                    onClick={(e) => { e.stopPropagation(); previewThisCard(); }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>preview</span>
                  </button>
                )}
                {isPresentationMode && (
                  <button
                    data-testid="capture-message-btn"
                    className={`${actionBtn} transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}
                    title="Capture this message as an image (or press P)"
                    onClick={(e) => { e.stopPropagation(); captureThisCard(); }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>photo_camera</span>
                  </button>
                )}
                <button
                  className={`${actionBtn} relative`}
                  title="Copy link to this message"
                  onClick={(e) => { e.stopPropagation(); copyMessageLink(); }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                    {copiedLink ? 'check' : 'link'}
                  </span>
                </button>
                <button
                  className={`rounded-md w-6 h-6 focus:outline-none focus:ring-4 flex justify-center items-center ${
                    sharedMsg
                      ? 'bg-green-600 text-white'
                      : isDarkMode ? 'text-emerald-400 bg-emerald-900/60' : 'text-emerald-700 bg-emerald-100'
                  } shadow-md shadow-black/20`}
                  title="Share this message (no password needed)"
                  onClick={(e) => { e.stopPropagation(); shareMessage(); }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                    {sharedMsg ? 'check' : 'share'}
                  </span>
                </button>
                <button
                  className={`rounded-md w-6 h-6 focus:outline-none focus:ring-4 flex justify-center items-center ${
                    copiedText ? 'bg-green-600 text-white' : config.buttonClassName
                  } shadow-md shadow-black/20`}
                  title="Copy message text (reasoning, content, tool calls)"
                  onClick={(e) => { e.stopPropagation(); copyMessageText(); }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                    {copiedText ? 'check' : 'content_copy'}
                  </span>
                </button>
                <button
                  className={actionBtn}
                  title="Remove this and all subsequent messages"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>cut</span>
                </button>
                <button
                  className={actionBtn}
                  title="Edit message"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>edit</span>
                </button>
              </div>
            </div>
          </div>

          {/* Content */}
          <div
            className={`grid transition-all duration-300 ease-in-out ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            style={{ overflowWrap: 'anywhere' }}
          >
            <div className="overflow-hidden">
              <div
                ref={contentRef}
                className="space-y-3 py-3"
              >
                {/* Reasoning block. When collapsed whole, it is NOT drawn
                    here — a standalone block would strand the [...] on its
                    own line; instead the [...] leads the main content below
                    inline (see the content block). */}
                {reasoning && !isSectionCollapsed(reasoning) && (
                  <div className="mx-3 rounded-md border-l-4 shadow-xs overflow-hidden reasoning">
                    <div className={`px-2 py-1 flex items-center justify-between gap-1 text-sm font-medium ${textSecondary} shadow-2xs reasoning-header`}>
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>lightbulb</span>
                        reasoning
                      </span>
                      {isPresentationMode && (
                        <button
                          type="button"
                          data-testid="collapse-reasoning-btn"
                          className={`presentation-chrome shrink-0 rounded p-0.5 ${isDarkMode ? 'text-gray-300 hover:bg-white/10' : 'text-gray-600 hover:bg-black/10'}`}
                          title="Collapse the whole reasoning section to [...]"
                          onClick={(e) => { e.stopPropagation(); onAddCollapsedRegion?.(index, reasoning); }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>unfold_less</span>
                        </button>
                      )}
                    </div>
                    <div data-msg-block data-block-kind="reasoning" className={`px-2 py-1 text-sm ${textPrimary} whitespace-pre-wrap`}>
                      {renderWithCollapse(reasoning, true, 'reasoning', -1, globalOccurrenceStarts.reasoningStart)}
                    </div>
                  </div>
                )}

                {/* Main content. A collapsed-whole reasoning section leads
                    here as an inline [...] so it shares the first line
                    (its right-click "same line" toggle then works). */}
                <div data-msg-block data-block-kind="content" className={`mx-3 whitespace-pre-wrap text-sm ${textPrimary}`}>
                  {reasoning && isSectionCollapsed(reasoning) && (
                    <>{renderWithCollapse(reasoning, true, 'reasoning', -1, globalOccurrenceStarts.reasoningStart)}{' '}</>
                  )}
                  {renderWithCollapse(mainContent, false, 'content', -1, globalOccurrenceStarts.contentStart)}
                </div>

                {/* Inline tool-call text — only when no structured tool calls
                    were extracted (older Kimi rows the parser didn't fully
                    recover). Today the parser always populates `toolCalls`. */}
                {toolCallText && toolCalls.length === 0 && (
                  <div className={`mx-3 rounded-md border overflow-hidden ${isDarkMode ? 'border-gray-600 bg-gray-800/50' : 'border-gray-200 bg-gray-50'}`}>
                    <div className={`px-2 py-1 flex items-center gap-1 text-xs font-medium ${isDarkMode ? 'bg-gray-700/50 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>terminal</span>
                      tool call
                    </div>
                    <pre className={`px-2 py-1 text-xs overflow-x-auto ${isDarkMode ? 'text-green-400' : 'text-gray-800'}`}>{toolCallText}</pre>
                  </div>
                )}

                {/* Structured tool calls (covers structured + Kimi/Harmony
                    extracted by the parser into the unified `toolCalls`). */}
                {toolCalls.length > 0 && (
                  <div className="mx-3 space-y-2">
                    {toolCalls.map((tc, tcIdx) => {
                      const args = toolCallArgsText(tc);
                      const isWrapped = wrappedToolCalls.has(`${index}:${tcIdx}`);
                      return isSectionCollapsed(args) ? (
                        // Inline span (not a block) so consecutive collapsed
                        // tool calls share a line instead of stacking.
                        <span key={tcIdx} className="text-xs whitespace-pre-wrap">{renderWithCollapse(args, false, 'tool', tcIdx, globalOccurrenceStarts.toolArgStarts[tcIdx] ?? messageOccurrenceStart)}</span>
                      ) : (
                        <div key={tcIdx} className={`rounded-md border overflow-hidden ${isDarkMode ? 'border-gray-600 bg-gray-800/50' : 'border-gray-200 bg-gray-50'}`}>
                          <div className={`px-2 py-1 flex items-center justify-between text-xs font-medium ${isDarkMode ? 'bg-gray-700/50 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                            <div className="flex items-center gap-1 min-w-0">
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>terminal</span>
                              <span className="truncate">{highlightSearchAndUrl(tc.function.name, false, 'tool', tcIdx, globalOccurrenceStarts.toolNameStarts[tcIdx] ?? messageOccurrenceStart)}</span>
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              {isPresentationMode && (
                                <button
                                  type="button"
                                  data-testid={`collapse-toolcall-btn-${tcIdx}`}
                                  onClick={(e) => { e.stopPropagation(); onAddCollapsedRegion?.(index, args); }}
                                  title="Collapse this whole tool call to [...]"
                                  className={`presentation-chrome rounded p-0.5 transition-colors ${
                                    isDarkMode ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-200'
                                  }`}
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_less</span>
                                </button>
                              )}
                              {/* Wrap toggle — opt-in soft-wrap for long heredocs / pasted output. */}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onToggleToolCallWrap?.(index, tcIdx); }}
                                title={isWrapped ? 'Disable wrapping (horizontal scroll)' : 'Wrap text to fit width'}
                                aria-label={isWrapped ? 'Disable wrapping' : 'Wrap text'}
                                aria-pressed={isWrapped}
                                data-testid={`tool-call-wrap-toggle-${tcIdx}`}
                                className={`presentation-chrome shrink-0 rounded p-0.5 transition-colors ${
                                  isWrapped
                                    ? (isDarkMode ? 'bg-blue-900/60 text-blue-200' : 'bg-blue-100 text-blue-700')
                                    : (isDarkMode ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-200')
                                }`}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>wrap_text</span>
                              </button>
                            </div>
                          </div>
                          <pre
                            data-msg-block
                            data-block-kind="tool"
                            data-block-index={tcIdx}
                            data-testid={`tool-call-pre-${tcIdx}`}
                            className={`px-2 py-1 text-xs ${
                              isWrapped ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'
                            } ${isDarkMode ? 'text-green-400' : 'text-gray-800'}`}
                          >
                            {renderWithCollapse(args, false, 'tool', tcIdx, globalOccurrenceStarts.toolArgStarts[tcIdx] ?? messageOccurrenceStart)}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Selection popup — highlight / collapse / copy-link / share-quote.
            Carries presentation-chrome so it never lands in a capture. */}
        {selectionPopup.show && (
          <div
            ref={popupRef}
            className={`selection-popup presentation-chrome absolute z-50 transform -translate-x-1/2 -translate-y-full flex items-center gap-1 px-2 py-1 rounded-lg shadow-lg ${
              isDarkMode ? 'bg-gray-800 border border-gray-600' : 'bg-white border border-gray-300'
            }`}
            style={{ top: selectionPopup.y }}
          >
            {/* Collapse — Presentation Mode only. Plain click collapses the
                selection; Alt-click isolates (collapses everything else). */}
            {isPresentationMode && (
              <>
                <button
                  data-testid="collapse-selection-btn"
                  onClick={(e) => { e.stopPropagation(); if (e.altKey) doIsolate(); else doCollapse(); }}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                    isDarkMode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                  title="Collapse selection — C  (O or Alt-click to isolate)"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_less</span>
                  Collapse
                </button>
                <div className={`w-px h-4 ${isDarkMode ? 'bg-gray-600' : 'bg-gray-300'}`} />
              </>
            )}
            {/* Ephemeral text styles — session-only, not shared, click the
                styled span to remove. */}
            <button
              onClick={() => applyFormat('highlight')}
              className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
                isDarkMode ? 'text-fuchsia-300 hover:bg-gray-700' : 'text-fuchsia-700 hover:bg-fuchsia-50'
              }`}
              title="Highlight selection — H  (session only)"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>ink_highlighter</span>
            </button>
            <button
              onClick={() => applyFormat('bold')}
              className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
                isDarkMode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
              }`}
              title="Bold selection — B"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>format_bold</span>
            </button>
            <button
              onClick={() => applyFormat('italic')}
              className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
                isDarkMode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
              }`}
              title="Italic selection — I"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>format_italic</span>
            </button>
            <div className={`w-px h-4 ${isDarkMode ? 'bg-gray-600' : 'bg-gray-300'}`} />
            <button
              onClick={copySelectionLink}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                isDarkMode
                  ? 'text-blue-400 hover:bg-gray-700'
                  : 'text-blue-600 hover:bg-blue-50'
              }`}
              title="Copy link with highlighted text"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                {copiedSelection ? 'check' : 'link'}
              </span>
              {copiedSelection ? 'Copied!' : 'Copy link'}
            </button>
            <div className={`w-px h-4 ${isDarkMode ? 'bg-gray-600' : 'bg-gray-300'}`} />
            <button
              onClick={async () => {
                try {
                  let token = shareToken;
                  if (!token) {
                    const res = await fetch('/api/share/create', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        file: filePath,
                        rollout: rolloutN,
                        step,
                        index: selectedIndexInFile,
                      }),
                    });
                    if (!res.ok) return;
                    const data = await res.json();
                    token = data.token;
                  }
                  if (token) {
                    const params = new URLSearchParams({
                      share: token,
                      message: index.toString(),
                      highlight: selectionPopup.text,
                    });
                    navigator.clipboard.writeText(`${PUBLIC_BASE_URL}/?${params.toString()}`);
                    setCopiedSelection(true);
                    setTimeout(() => {
                      setCopiedSelection(false);
                      setSelectionPopup(prev => ({ ...prev, show: false }));
                    }, 1500);
                  }
                } catch { /* ignore */ }
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                isDarkMode
                  ? 'text-emerald-400 hover:bg-gray-700'
                  : 'text-emerald-600 hover:bg-emerald-50'
              }`}
              title="Share this quote (no password needed)"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>share</span>
              Share quote
            </button>
            <div className={`w-px h-4 ${isDarkMode ? 'bg-gray-600' : 'bg-gray-300'}`} />
            <button
              onClick={() => setSelectionPopup(prev => ({ ...prev, show: false }))}
              className={`p-1 rounded transition-colors ${
                isDarkMode
                  ? 'text-gray-400 hover:bg-gray-700'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
              title="Close"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
            </button>
            {/* Arrow */}
            <div
              className={`absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 ${
                isDarkMode
                  ? 'border-l-transparent border-r-transparent border-t-gray-800'
                  : 'border-l-transparent border-r-transparent border-t-white'
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// SearchField is referenced via the props interface only as part of
// SearchCondition; suppress the unused-import lint without dropping the
// type re-export for clarity.
void (null as unknown as SearchField);

export const MessageCard = memo(MessageCardInner);
