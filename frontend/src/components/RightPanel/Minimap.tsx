import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Message, Quote, SearchCondition } from '../../types';
import { buildSearchCorpus, countMessageOccurrences } from '../../utils/parseContent';
import { findAllMatchesCI } from '../../utils/textMatch';
import { computeMinimapHeights, minimapCharCount } from '../../utils/minimapScale';

// ---------------------------------------------------------------------------
// Conversation minimap — a slim vertical rail beside the transcript.
// ---------------------------------------------------------------------------
// One block per message (height log-scaled to text length, colored by role
// from the existing message palette), a live viewport indicator, and tick
// overlays for search hits / grade quotes / the URL deep link. Clicking a
// block scrolls its message into view. Rendered as an absolutely positioned
// sibling of the scroll container (never inside it — the Cmd+C handler maps
// messages via `:scope > div` on that container), so it causes zero layout
// shift and the capture pipeline, which clones individual cards, never sees
// it. It hides itself whenever the whole transcript already fits on screen.

// Muted essences of the .message-* role palette in index.css. The dark
// variants lift the darkest hues (tool's #264653 vanishes on the dark bg).
const ROLE_COLORS: Record<string, { light: string; dark: string }> = {
  system: { light: '#e76f51', dark: '#c75a3f' },
  user: { light: '#2a9d8f', dark: '#2a9d8f' },
  assistant: { light: '#e9c46a', dark: '#c9a44a' },
  tool: { light: '#264653', dark: '#5c8a97' },
  file: { light: '#607d8b', dark: '#90a4ae' },
};

// Marker colors mirror the transcript's highlight conventions: blue URL
// deep-link > purple grade quotes > green in-chat search > yellow global
// search (same priority order MessageCard paints them in).
const MARKERS = [
  { kind: 'deeplink', color: '#3b82f6' },
  { kind: 'quote', color: '#a855f7' },
  { kind: 'local', color: '#22c55e' },
  { kind: 'global', color: '#eab308' },
] as const;

// Rail geometry. The rail spans the transcript wrapper from below the
// floating toolbar cluster (top-12) to just above the bottom edge; blocks
// live inside a small vertical padding.
const RAIL_TOP = 48;
const RAIL_BOTTOM = 12;
const RAIL_PAD_Y = 4;
const BLOCK_GAP = 2;
const MIN_VIEWPORT_PX = 12;

const EMPTY_SET: ReadonlySet<number> = new Set<number>();

interface MeasureState {
  /** Content-space top of each message wrapper, px from the container's scroll origin. */
  tops: number[];
  heights: number[];
  scrollHeight: number;
  clientHeight: number;
}

interface MinimapProps {
  messages: Message[];
  /** The transcript's scroll container (ChatView's messagesContainerRef). */
  containerRef: RefObject<HTMLDivElement | null>;
  isDarkMode: boolean;
  searchConditions: SearchCondition[];
  localSearchTerm: string;
  gradeQuotes: Quote[];
  highlightedMessageIndex: number | null;
  onMessageClick: (index: number) => void;
}

function MinimapInner({
  messages,
  containerRef,
  isDarkMode,
  searchConditions,
  localSearchTerm,
  gradeQuotes,
  highlightedMessageIndex,
  onMessageClick,
}: MinimapProps) {
  const [measure, setMeasure] = useState<MeasureState | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const doMeasure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect().top - container.scrollTop;
    const children = Array.from(container.children) as HTMLElement[];
    setMeasure({
      tops: children.map((ch) => ch.getBoundingClientRect().top - base),
      heights: children.map((ch) => ch.getBoundingClientRect().height),
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    });
    setScrollTop(container.scrollTop);
  }, [containerRef]);

  // Measure on mount / whenever the message set changes, and re-measure when
  // the panel resizes or any card collapses/expands (ResizeObserver on the
  // container and each message wrapper). jsdom has no ResizeObserver — the
  // guard degrades to a single measure there.
  useEffect(() => {
    doMeasure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => doMeasure());
    ro.observe(container);
    for (const child of Array.from(container.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [doMeasure, containerRef, messages]);

  // Track the viewport with a RAF-throttled passive scroll listener —
  // the same coalescing pattern as SampleTable's virtual scroller.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      rafIdRef.current = null;
      setScrollTop(container.scrollTop);
    };
    const handleScroll = () => {
      if (rafIdRef.current !== null) return; // Already scheduled
      rafIdRef.current = requestAnimationFrame(update);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [containerRef]);

  const charCounts = useMemo(() => messages.map(minimapCharCount), [messages]);

  // Message indices with at least one global-search hit (yellow ticks).
  const globalHits = useMemo(() => {
    const active = searchConditions.filter((c) => c.operator === 'contains' && c.term.trim());
    if (active.length === 0) return EMPTY_SET;
    const hits = new Set<number>();
    messages.forEach((m, i) => {
      if (countMessageOccurrences(m, active) > 0) hits.add(i);
    });
    return hits;
  }, [messages, searchConditions]);

  // Message indices with at least one in-chat (Ctrl+F) match (green ticks).
  const localHits = useMemo(() => {
    const term = localSearchTerm.trim();
    if (!term) return EMPTY_SET;
    const hits = new Set<number>();
    messages.forEach((m, i) => {
      if (findAllMatchesCI(buildSearchCorpus(m), term).length > 0) hits.add(i);
    });
    return hits;
  }, [messages, localSearchTerm]);

  // Message indices carrying grade-quote evidence (purple ticks).
  const quoteHits = useMemo(
    () => (gradeQuotes.length === 0 ? EMPTY_SET : new Set(gradeQuotes.map((q) => q.message_index))),
    [gradeQuotes],
  );

  const railInnerH = measure
    ? measure.clientHeight - RAIL_TOP - RAIL_BOTTOM - 2 * RAIL_PAD_Y - 2
    : 0;

  // Hide entirely when the transcript fits without scrolling (a minimap of a
  // fully visible page is noise) or the pane is too short to be useful.
  const visible =
    measure !== null &&
    messages.length > 0 &&
    measure.scrollHeight > measure.clientHeight + 8 &&
    railInnerH >= 40;

  // Block layout: log-scaled heights normalized to fill the rail exactly.
  const { blockHeights, blockTops } = useMemo(() => {
    if (!visible) return { blockHeights: [] as number[], blockTops: [] as number[] };
    const available = railInnerH - BLOCK_GAP * Math.max(0, messages.length - 1);
    const heights = computeMinimapHeights(charCounts, available);
    const tops: number[] = [];
    let y = 0;
    for (const h of heights) {
      tops.push(y);
      y += h + BLOCK_GAP;
    }
    return { blockHeights: heights, blockTops: tops };
  }, [visible, railInnerH, charCounts, messages.length]);

  if (!visible) return null;

  const n = messages.length;
  const measured = Math.min(n, measure.tops.length);

  // Map a content-space y (px in the scroll container) to rail-space,
  // piecewise-linearly through the message blocks so the viewport indicator
  // stays truthful even though block heights are log-scaled.
  const mapY = (y: number): number => {
    if (measured === 0) {
      return measure.scrollHeight > 0 ? (y / measure.scrollHeight) * railInnerH : 0;
    }
    if (y <= measure.tops[0]) return 0;
    for (let i = 0; i < measured; i++) {
      const end = i + 1 < measured
        ? measure.tops[i + 1]
        : measure.tops[i] + measure.heights[i];
      if (y < end) {
        const span = Math.max(1, end - measure.tops[i]);
        const frac = (y - measure.tops[i]) / span;
        return blockTops[i] + frac * (blockHeights[i] + (i + 1 < measured ? BLOCK_GAP : 0));
      }
    }
    return railInnerH;
  };

  const viewportTopRaw = mapY(scrollTop);
  const viewportBottom = mapY(scrollTop + measure.clientHeight);
  const viewportH = Math.max(MIN_VIEWPORT_PX, viewportBottom - viewportTopRaw);
  const viewportTop = Math.max(0, Math.min(viewportTopRaw, railInnerH - viewportH));

  const theme = isDarkMode ? 'dark' : 'light';
  const hovered = hoverIndex !== null && hoverIndex < n ? hoverIndex : null;
  const hoverPreview = hovered !== null
    ? buildSearchCorpus(messages[hovered]).replace(/\s+/g, ' ').trim().slice(0, 60)
    : '';

  const deeplinkHits: ReadonlySet<number> =
    highlightedMessageIndex !== null ? new Set([highlightedMessageIndex]) : EMPTY_SET;
  const markerLayers = [
    { ...MARKERS[0], set: deeplinkHits },
    { ...MARKERS[1], set: quoteHits },
    { ...MARKERS[2], set: localHits },
    { ...MARKERS[3], set: globalHits },
  ];

  return (
    <div
      data-testid="conversation-minimap"
      aria-label="Conversation minimap"
      // A bare strip, not a boxed panel — the blocks themselves are the rail
      // (editor-minimap style). The transcript scroller reserves a right
      // gutter (pr-7) so cards never run underneath.
      className="absolute z-10 w-2 select-none"
      style={{ top: RAIL_TOP, bottom: RAIL_BOTTOM, right: 10 }}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <div className="absolute" style={{ top: RAIL_PAD_Y, bottom: RAIL_PAD_Y, left: 0, right: 0 }}>
        {messages.map((message, i) => {
          const color = (ROLE_COLORS[message.role] ?? ROLE_COLORS.system)[theme];
          return (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              data-testid={`minimap-block-${i}`}
              data-role={message.role}
              aria-label={`Jump to message ${i + 1} (${message.role})`}
              className="absolute left-0 right-0 rounded-full cursor-pointer transition-opacity duration-100 motion-reduce:transition-none"
              style={{
                top: blockTops[i],
                height: Math.max(1, blockHeights[i] ?? 0),
                backgroundColor: color,
                opacity: hovered === i ? 1 : isDarkMode ? 0.7 : 0.6,
              }}
              onClick={() => onMessageClick(i)}
              onMouseEnter={() => setHoverIndex(i)}
            />
          );
        })}

        {/* Tick overlays — one short bar per category per message, stacked
            from the block's top in highlight-priority order. */}
        {messages.map((_, i) => {
          const present = markerLayers.filter((m) => m.set.has(i));
          return present.map(({ kind, color }, slot) => (
            <div
              key={`${kind}-${i}`}
              data-testid={`minimap-tick-${kind}-${i}`}
              className="absolute pointer-events-none rounded-full"
              style={{
                top: blockTops[i] + 1 + slot * 3,
                left: 1,
                right: 1,
                height: 2,
                backgroundColor: color,
              }}
            />
          ));
        })}

        {/* Viewport indicator — the currently visible slice of the transcript. */}
        <div
          data-testid="minimap-viewport"
          className={`absolute pointer-events-none rounded-full border ${
            isDarkMode ? 'border-gray-300/70 bg-gray-300/15' : 'border-gray-600/60 bg-gray-500/10'
          }`}
          style={{ top: viewportTop, height: viewportH, left: -2, right: -2 }}
        />
      </div>

      {/* Hover tooltip — role, index, first ~60 chars. */}
      {hovered !== null && (
        <div
          data-testid="minimap-tooltip"
          className={`absolute right-full mr-2 z-20 pointer-events-none px-2 py-1 rounded border shadow-md text-[11px] leading-snug w-max max-w-[18rem] ${
            isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200' : 'bg-white border-gray-300 text-gray-700'
          }`}
          style={{
            top: Math.max(0, Math.min((blockTops[hovered] ?? 0) + RAIL_PAD_Y - 6, railInnerH - 28)),
          }}
        >
          <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            #{hovered + 1} · {messages[hovered].role}
          </span>
          {hoverPreview && (
            <span className="block truncate max-w-[17rem]">{hoverPreview}</span>
          )}
        </div>
      )}
    </div>
  );
}

export const Minimap = memo(MinimapInner);
