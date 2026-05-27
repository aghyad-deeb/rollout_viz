import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { Sample, Message, SearchCondition, Quote, EphemeralHighlight, CollapsedRegion, RegionLocator, ExportWidth, FontSize } from '../../types';
import { MessageCard } from './MessageCard';
import { GradesDisplay } from './GradesDisplay';
import { countMessageOccurrences, buildSearchCorpus } from '../../utils/parseContent';
import { findAllMatchesCI } from '../../utils/textMatch';
import { extractHighlightAnchor } from '../../utils/textSnippet';
import { captureCardToPng, copyImageToClipboard, downloadBlob, FONT_SIZE_PRESETS } from '../../utils/captureImage';
import { addPngTextChunk, readPngTextChunks } from '../../utils/pngMetadata';
import { CapturePreviewModal } from './CapturePreviewModal';
import { PUBLIC_BASE_URL } from '../../config';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface ChatViewProps {
  sample: Sample;
  searchConditions: SearchCondition[]; // Global search conditions from left panel
  currentOccurrenceIndex: number; // Which occurrence to scroll to (0-indexed)
  isDarkMode: boolean;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; step?: number; index?: number; message?: number; highlight?: string }) => string;
  highlightedMessageIndex: number | null;
  highlightedText: string | null;
  onClearHighlight: () => void;
  selectedGradeMetric?: string;
  onSelectGradeMetric?: (metric: string | undefined) => void;
  isSharedMode?: boolean;
  shareToken?: string | null;
  // File-relative position of this sample. Forwarded to MessageCard so
  // message/quote share links include it in the token payload.
  selectedIndexInFile?: number;
  // Presentation Mode (capture rollout snippets as images).
  isPresentationMode?: boolean;
  imageTheme?: 'light' | 'dark';
  exportWidth?: ExportWidth;
  fontSize?: FontSize;
  onPresentationPreview?: (url: string | null, blob?: Blob | null) => void;
}

interface LocalMatch {
  messageIndex: number;
  matchIndex: number; // Which occurrence within the message
}

export function ChatView({ 
  sample, 
  searchConditions,
  currentOccurrenceIndex,
  isDarkMode,
  filePath,
  generateLink,
  highlightedMessageIndex,
  highlightedText,
  onClearHighlight,
  selectedGradeMetric,
  onSelectGradeMetric,
  isSharedMode = false,
  shareToken,
  selectedIndexInFile,
  isPresentationMode = false,
  imageTheme = 'light',
  exportWidth = 'paper1',
  fontSize = 'md',
  onPresentationPreview,
}: ChatViewProps) {
  // Extract quotes from the selected grade metric
  const gradeQuotes = useMemo((): Quote[] => {
    if (!selectedGradeMetric || !sample.grades || !sample.grades[selectedGradeMetric]) {
      return [];
    }
    const grades = sample.grades[selectedGradeMetric];
    if (grades.length === 0) return [];
    
    // Get quotes from the latest grade
    const latestGrade = grades[grades.length - 1];
    return latestGrade.quotes || [];
  }, [sample.grades, selectedGradeMetric]);
  // Get active search terms for highlighting (only 'contains' conditions with non-empty terms)
  const activeSearchTerms = useMemo(() => 
    searchConditions
      .filter(c => c.operator === 'contains' && c.term.trim())
      .map(c => c.term.trim()),
    [searchConditions]
  );
  
  // Get the first active condition for scroll targeting
  const primarySearchTerm = activeSearchTerms[0] || '';

  // Calculate the starting occurrence index for each message (cumulative count).
  // Uses the same normalized text and field scoping as MessageCard highlights.
  const messageOccurrenceStarts = useMemo(() => {
    const starts: number[] = [];
    let cumulativeCount = 0;
    const activeConditions = searchConditions.filter(c => c.operator === 'contains' && c.term.trim());

    sample.messages.forEach((message) => {
      starts.push(cumulativeCount);
      cumulativeCount += countMessageOccurrences(message, activeConditions);
    });
    
    return starts;
  }, [sample.messages, searchConditions]);

  const [localSearchTerm, setLocalSearchTerm] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [currentQuoteIndex, setCurrentQuoteIndex] = useState(0);
  // Ephemeral, session-only highlights: not persisted anywhere, cleared
  // whenever the user navigates to a different sample.
  const [ephemeralHighlights, setEphemeralHighlights] = useState<EphemeralHighlight[]>([]);
  // Per-tool-call soft-wrap state, lifted here (not MessageCard-local) so the
  // off-screen capture card mirrors it. Keys are `"${messageIndex}:${tcIdx}"`.
  const [wrappedToolCalls, setWrappedToolCalls] = useState<Set<string>>(new Set());
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastScrolledSampleId = useRef<number | null>(null);
  const lastScrolledSearchTerm = useRef<string>('');

  // Presentation Mode: session-only collapsed regions, same lifecycle as
  // ephemeral highlights. `collapseUndoRef` is a snapshot stack for Ctrl+Z;
  // `collapsedRegionsRef` mirrors the latest state so the mutators can push
  // an accurate pre-mutation snapshot without a stale closure.
  const [collapsedRegions, setCollapsedRegions] = useState<CollapsedRegion[]>([]);
  const collapsedRegionsRef = useRef<CollapsedRegion[]>([]);
  const collapseUndoRef = useRef<CollapsedRegion[][]>([]);
  // Scroll-anchor for a pending collapse: the collapsed message's bottom
  // edge (container-relative), captured pre-mutation and restored after, so
  // collapsing doesn't shift later content up out of view.
  const collapseScrollAnchorRef = useRef<{ messageIndex: number; bottom: number } | null>(null);
  // Presentation Mode: the capture-preview modal. `previewUrlRef` tracks the
  // live object URL so it can be revoked imperatively — an effect-cleanup
  // revoke fires during StrictMode's mount/cleanup/mount cycle and would
  // kill a URL the <img> still needs.
  const [preview, setPreview] = useState<{ url: string; blob: Blob; caption: string } | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  // The card under the pointer (kept when the pointer leaves, so it falls
  // back to the last one touched) — subject of the left-panel live preview.
  // The message being captured/previewed: index of the card last clicked.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const leftPreviewUrlRef = useRef<string | null>(null);
  // Off-screen <body>-level host (outside #root, so it escapes the app
  // theme). The capture card is portalled into it in the image theme;
  // captures clone from here, making them theme-independent.
  const [captureHost] = useState(() => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:-99999px;top:0;width:760px;pointer-events:none;';
    el.setAttribute('aria-hidden', 'true');
    return el;
  });
  // Mount the off-screen capture host in <body> — outside #root, so it
  // escapes the app theme — for the component's lifetime.
  useEffect(() => {
    document.body.appendChild(captureHost);
    return () => { captureHost.remove(); };
  }, [captureHost]);
  // Carry the image theme on the host as a `.dark` class so the portalled
  // capture card's `.dark .message-*` CSS resolves to the image theme,
  // independent of the app UI theme.
  useEffect(() => {
    captureHost.classList.toggle('dark', imageTheme === 'dark');
  }, [captureHost, imageTheme]);
  // Mirror the latest collapsedRegions into a ref (updated post-commit, not
  // during render) so the mutators below can snapshot pre-mutation state
  // for undo without a stale closure or an impure setState updater.
  useEffect(() => {
    collapsedRegionsRef.current = collapsedRegions;
  }, [collapsedRegions]);

  // After a collapse shrinks a message card, restore the pinned bottom edge
  // so everything from the collapse downward stays where it was (instead of
  // jumping up under the unchanged scrollTop). Runs before paint, so the
  // adjustment is invisible. Only `addCollapsedRegion` arms the anchor —
  // expand / undo / label edits leave it null and pass through untouched.
  useLayoutEffect(() => {
    const anchor = collapseScrollAnchorRef.current;
    if (!anchor) return;
    collapseScrollAnchorRef.current = null;
    const container = messagesContainerRef.current;
    const el = messageRefs.current.get(anchor.messageIndex);
    if (!container || !el) return;
    const bottom = el.getBoundingClientRect().bottom - container.getBoundingClientRect().top;
    container.scrollTop += bottom - anchor.bottom;
  }, [collapsedRegions]);

  // Revoke any live preview URL on unmount. previewUrlRef is null during the
  // StrictMode mount/cleanup/mount remount, so this cleanup is a safe no-op
  // then and frees a real URL only on a genuine unmount.
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  // Close the capture-preview modal, freeing its object URL.
  const closePreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  }, []);

  // Drop all session-only state when the user moves to a different sample.
  useEffect(() => {
    setEphemeralHighlights([]);
    setCollapsedRegions([]);
    setWrappedToolCalls(new Set());
    collapseUndoRef.current = [];
    collapseScrollAnchorRef.current = null;
    closePreview();
    setActiveIndex(null);
  }, [sample.id, closePreview]);

  const newId = (prefix: string) =>
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const addCollapsedRegion = useCallback((messageIndex: number, text: string, locator?: RegionLocator) => {
    if (!text.trim()) return;
    // Pin the collapsed message's bottom edge: record it now, restore it in
    // a layout effect once the (now shorter) card has re-rendered.
    const container = messagesContainerRef.current;
    const el = messageRefs.current.get(messageIndex);
    if (container && el) {
      collapseScrollAnchorRef.current = {
        messageIndex,
        bottom: el.getBoundingClientRect().bottom - container.getBoundingClientRect().top,
      };
    }
    collapseUndoRef.current.push(collapsedRegionsRef.current);
    if (collapseUndoRef.current.length > 100) collapseUndoRef.current.shift();
    setCollapsedRegions((prev) => [...prev, { id: newId('cr'), messageIndex, text, locator }]);
  }, []);

  const removeCollapsedRegion = useCallback((id: string) => {
    collapseUndoRef.current.push(collapsedRegionsRef.current);
    setCollapsedRegions((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const updateCollapsedRegionLabel = useCallback((id: string, label: string | undefined) => {
    collapseUndoRef.current.push(collapsedRegionsRef.current);
    setCollapsedRegions((prev) => prev.map((r) => (r.id === id ? { ...r, label } : r)));
  }, []);

  // Hide a pill: the region stays collapsed but renders no `[...]` marker.
  const hideCollapsedRegion = useCallback((id: string) => {
    collapseUndoRef.current.push(collapsedRegionsRef.current);
    setCollapsedRegions((prev) => prev.map((r) => (r.id === id ? { ...r, hidden: true } : r)));
  }, []);

  // Toggle whether a pill shares a line with the text before / after it.
  const updateCollapsedRegionJoin = useCallback((id: string, side: 'before' | 'after', value: boolean) => {
    collapseUndoRef.current.push(collapsedRegionsRef.current);
    setCollapsedRegions((prev) => prev.map((r) =>
      r.id === id ? { ...r, [side === 'before' ? 'joinBefore' : 'joinAfter']: value } : r,
    ));
  }, []);

  // Expand every collapsed region in one message — the recovery path when
  // its ellipses have been hidden (no pill left to click).
  const expandMessageCollapses = useCallback((messageIndex: number) => {
    if (!collapsedRegionsRef.current.some((r) => r.messageIndex === messageIndex)) return;
    collapseUndoRef.current.push(collapsedRegionsRef.current);
    setCollapsedRegions((prev) => prev.filter((r) => r.messageIndex !== messageIndex));
  }, []);

  const undoCollapse = useCallback(() => {
    const prev = collapseUndoRef.current.pop();
    if (prev !== undefined) setCollapsedRegions(prev);
  }, []);

  const clearCollapsedRegions = useCallback(() => {
    if (collapsedRegionsRef.current.length === 0) return;
    collapseUndoRef.current.push(collapsedRegionsRef.current);
    setCollapsedRegions([]);
  }, []);

  // Ctrl/Cmd+Z reverts the last collapse action while in presentation mode.
  useEffect(() => {
    if (!isPresentationMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      undoCollapse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPresentationMode, undoCollapse]);

  // Resolve the chosen font-size preset to a numeric multiplier.
  const fontScale = FONT_SIZE_PRESETS.find((p) => p.id === fontSize)?.scale ?? 1;

  // The deep-link JSON embedded as hidden PNG metadata — lets an exported
  // image be dropped back onto the chat to revisit its source rollout.
  const buildLinkMeta = useCallback((messageIndex: number) => {
    const url = generateLink({
      file: filePath,
      rollout: sample.attributes.rollout_n,
      step: sample.attributes.step,
      index: selectedIndexInFile,
      message: messageIndex,
    });
    return JSON.stringify({
      url,
      file: filePath,
      rollout: sample.attributes.rollout_n,
      step: sample.attributes.step,
      message: messageIndex,
    });
  }, [generateLink, filePath, sample.attributes, selectedIndexInFile]);

  // Render a message card to a PNG with a deep link embedded as hidden
  // metadata; returns it with a provenance caption. Shared by the
  // capture-to-clipboard and the preview paths.
  //
  // `flushSync` commits the off-screen portal card for `messageIndex` (in
  // the image theme) synchronously, so the capture clones the right card
  // whether it was reached by a click — which pre-sets `activeIndex` — or
  // by the `P` shortcut on a merely-hovered card.
  const buildCapturePng = useCallback(async (messageIndex: number) => {
    flushSync(() => setActiveIndex(messageIndex));
    const cardEl = captureHost.firstElementChild as HTMLElement | null;
    if (!cardEl) throw new Error('capture card is not mounted');
    const rawPng = await captureCardToPng(cardEl, { exportWidth, imageTheme, fontScale });
    const png = await addPngTextChunk(rawPng, 'rollout-viz', buildLinkMeta(messageIndex));
    const caption =
      `${sample.attributes.experiment_name} · rollout ${sample.attributes.rollout_n}` +
      ` · step ${sample.attributes.step}`;
    return { png, caption };
  }, [captureHost, exportWidth, imageTheme, fontScale, buildLinkMeta, sample.attributes]);

  // P / camera button: capture straight to the clipboard.
  const captureMessage = useCallback(async (messageIndex: number) => {
    try {
      const { png, caption } = await buildCapturePng(messageIndex);
      await copyImageToClipboard(png, caption);
    } catch (err) {
      console.error('[presentation] capture failed', err);
    }
  }, [buildCapturePng]);

  // Preview button: render the same PNG and open it in a modal so the user
  // can check it before copying.
  const previewMessage = useCallback(async (messageIndex: number) => {
    try {
      const { png, caption } = await buildCapturePng(messageIndex);
      const url = URL.createObjectURL(png);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreview({ url, blob: png, caption });
    } catch (err) {
      console.error('[presentation] preview failed', err);
    }
  }, [buildCapturePng]);

  // A MessageCard reports its index when clicked; that card becomes the
  // subject of the off-screen capture portal and the left-panel preview.
  const handlePreviewSelect = useCallback((messageIndex: number) => {
    setActiveIndex(messageIndex);
  }, []);

  // Keep the left-panel preview in sync with the active (clicked) card.
  // Reads the off-screen portal card — rendered in the image theme — so the
  // preview matches the eventual capture exactly. Debounced so rapid
  // collapses / setting changes coalesce.
  useEffect(() => {
    if (!isPresentationMode || activeIndex === null || !onPresentationPreview) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const cardEl = captureHost.firstElementChild as HTMLElement | null;
      if (!cardEl) return;
      try {
        const raw = await captureCardToPng(cardEl, { exportWidth, imageTheme, fontScale });
        const blob = await addPngTextChunk(raw, 'rollout-viz', buildLinkMeta(activeIndex));
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (leftPreviewUrlRef.current) URL.revokeObjectURL(leftPreviewUrlRef.current);
        leftPreviewUrlRef.current = url;
        onPresentationPreview(url, blob);
      } catch { /* best-effort — leave the last preview in place */ }
    }, 380);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isPresentationMode, activeIndex, collapsedRegions, ephemeralHighlights, wrappedToolCalls, exportWidth, imageTheme, fontScale, onPresentationPreview, captureHost, buildLinkMeta]);

  // Free the left-panel preview URL on unmount.
  useEffect(() => () => {
    if (leftPreviewUrlRef.current) URL.revokeObjectURL(leftPreviewUrlRef.current);
  }, []);

  // Drag an exported PNG back onto the chat → read its embedded link and
  // navigate to that rollout. Makes the hidden metadata round-trip.
  const handlePngDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || file.type !== 'image/png') return;
    try {
      const chunks = await readPngTextChunks(file);
      const raw = chunks['rollout-viz'];
      if (!raw) return;
      const meta = JSON.parse(raw) as { url?: string };
      if (meta.url) window.location.href = meta.url;
    } catch { /* not one of our exports — ignore */ }
  }, []);

  // Stable callbacks — memoized so React.memo'd MessageCards don't re-render
  // every time ChatView re-renders for unrelated reasons.
  const addEphemeralHighlight = useCallback((messageIndex: number, text: string, style?: 'highlight' | 'bold' | 'italic', locator?: RegionLocator) => {
    if (!text) return;
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `eh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setEphemeralHighlights((prev) => [...prev, { id, messageIndex, text, style, locator }]);
  }, []);

  const removeEphemeralHighlight = useCallback((id: string) => {
    setEphemeralHighlights((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const clearEphemeralHighlights = useCallback(() => {
    setEphemeralHighlights([]);
  }, []);

  // Toggle soft-wrap for one tool call's output. Lifted state so the capture
  // card honours the wrap (it is a separate MessageCard instance).
  const toggleToolCallWrap = useCallback((messageIndex: number, tcIdx: number) => {
    const key = `${messageIndex}:${tcIdx}`;
    setWrappedToolCalls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  
  // Reset quote index when metric changes
  useEffect(() => {
    setCurrentQuoteIndex(0);
  }, [selectedGradeMetric]);

  // Find all matches in the current chat.
  //
  // The corpus is `buildSearchCorpus(message)` rather than `message.content`
  // so the searcher sees the same text the renderer shows: reasoning from
  // either `<think>` tags or `content_parts`, structured tool-call function
  // names and arguments, harmony-final text — and *not* the marker tokens
  // (`<|im_*|>`, `<|channel|>`, …) that the renderer strips. See
  // `parseContent.buildSearchCorpus` for the rationale.
  //
  // The match itself goes through `findAllMatchesCI`, which normalizes
  // U+202F / U+00A0 / etc. whitespace to U+0020 so a query of `"7 am"`
  // matches `"7 am"` in the corpus. Without this, copy-pasted text
  // (e.g. from formatted memos) silently failed to surface.
  const localMatches = useMemo((): LocalMatch[] => {
    const term = localSearchTerm.trim();
    if (!term) return [];
    const matches: LocalMatch[] = [];
    sample.messages.forEach((message, messageIndex) => {
      const corpus = buildSearchCorpus(message);
      const found = findAllMatchesCI(corpus, term);
      for (let i = 0; i < found.length; i++) {
        matches.push({ messageIndex, matchIndex: i });
      }
    });
    return matches;
  }, [sample.messages, localSearchTerm]);

  // Reset current match when search term changes
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [localSearchTerm]);

  // Scroll to current match
  const scrollToMatch = useCallback((matchIdx: number) => {
    if (localMatches.length === 0 || matchIdx >= localMatches.length) return;
    
    const match = localMatches[matchIdx];
    const messageElement = messageRefs.current.get(match.messageIndex);
    
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [localMatches]);

  // Navigate to next/prev match
  const navigateMatch = useCallback((direction: 'next' | 'prev') => {
    if (localMatches.length === 0) return;
    
    let newIndex: number;
    if (direction === 'next') {
      newIndex = (currentMatchIndex + 1) % localMatches.length;
    } else {
      newIndex = (currentMatchIndex - 1 + localMatches.length) % localMatches.length;
    }
    
    setCurrentMatchIndex(newIndex);
    scrollToMatch(newIndex);
  }, [currentMatchIndex, localMatches.length, scrollToMatch]);

  // Handle keyboard shortcuts
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        navigateMatch('prev');
      } else {
        navigateMatch('next');
      }
    } else if (e.key === 'Escape') {
      setIsSearchOpen(false);
      setLocalSearchTerm('');
    }
  };

  // Toggle search with Ctrl/Cmd + F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Cmd+C: copy selected text as a hyperlink to the specific quote
  useEffect(() => {
    async function handleHyperlinkedCopy(e: KeyboardEvent) {
      if (!(e.key === 'c' || e.key === 'C')) return;
      if (e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const rawText = sel.toString();
      if (!rawText.trim()) return;

      const anchor = sel.anchorNode;
      if (!anchor) return;
      const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
      if (!el || !messagesContainerRef.current?.contains(el)) return;

      // Find which message the selection is in
      const allMsgEls = Array.from(messagesContainerRef.current.querySelectorAll(':scope > div'));
      let msgIndex = -1;
      for (let i = 0; i < allMsgEls.length; i++) {
        if (allMsgEls[i].contains(el)) { msgIndex = i; break; }
      }
      if (msgIndex < 0) return;

      // Two derived strings:
      //   • visibleText goes on the clipboard (both text/html anchor body
      //     and text/plain) — same content the user actually selected,
      //     trimmed at the edges.
      //   • anchorText is the URL `highlight=` parameter — first sentence
      //     / first line / first 120 chars, whichever is shortest. Keeps
      //     URLs short and the recipient's text-match more robust.
      const visibleText = rawText.trim();
      const anchorText = extractHighlightAnchor(visibleText);

      // Build the URL — use share token if in shared mode, otherwise regular link
      let url: string;
      if (shareToken) {
        const p = new URLSearchParams({ share: shareToken, message: msgIndex.toString(), highlight: anchorText });
        url = `${PUBLIC_BASE_URL}/?${p.toString()}`;
      } else {
        url = generateLink({ file: filePath, rollout: sample.attributes.rollout_n, step: sample.attributes.step, message: msgIndex, highlight: anchorText });
      }

      e.preventDefault();
      const html = `<a href="${escapeHtml(url)}">${escapeHtml(visibleText)}</a>`;
      const htmlBlob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([visibleText], { type: 'text/plain' });
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob }),
        ]);
      } catch {
        // Fallback: just copy the text normally
        await navigator.clipboard.writeText(visibleText);
      }
    }

    document.addEventListener('keydown', handleHyperlinkedCopy);
    return () => document.removeEventListener('keydown', handleHyperlinkedCopy);
  }, [shareToken, filePath, sample.attributes.rollout_n, sample.attributes.step, generateLink]);

  // Auto-scroll to a shared message / quote when the URL carries
  // `message=<idx>` (and optionally `highlight=<text>`).
  //
  // We wait for `document.fonts.ready` and two animation frames before
  // measuring — Material Symbols icons in every card header load as a web
  // font, and without this wait each sibling card's height can shift by a few
  // pixels *after* our smooth-scroll has already left for a stale target.
  // When a `highlight` is present we scroll to the `<mark>` itself (centered)
  // instead of the card header, otherwise the quote can sit well below the
  // fold for long messages with reasoning traces.
  //
  // `sample.messages.length` is in the dep array because non-share mode
  // hydrates messages progressively: the first render can land here with an
  // empty `messages` array (metadata-only phase), then `loadMultipleSamplesFull`
  // or the on-demand loader replaces it with the real messages while
  // `sample.id` stays the same. Without the length dep, the effect wouldn't
  // re-run when the real messages finally arrive and the scroll never fires.
  useEffect(() => {
    if (highlightedMessageIndex === null) return;
    if (sample.messages.length <= highlightedMessageIndex) return;
    let cancelled = false;

    const run = async () => {
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        try { await document.fonts.ready; } catch { /* ignore */ }
      }
      if (cancelled) return;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      if (cancelled) return;

      const messageEl = messageRefs.current.get(highlightedMessageIndex);
      const container = messagesContainerRef.current;
      if (!messageEl || !container) return;

      const mark = highlightedText
        ? messageEl.querySelector<HTMLElement>('mark.url-highlight-mark')
        : null;

      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const elRect = messageEl.getBoundingClientRect();
      container.scrollTo({
        top: container.scrollTop + elRect.top - containerRect.top - 16,
        behavior: 'smooth',
      });
    };

    run();
    return () => { cancelled = true; };
  }, [highlightedMessageIndex, highlightedText, sample.id, sample.messages.length]);

  // Track which occurrence we last scrolled to
  const lastScrolledOccurrenceIndex = useRef<number>(-1);

  // Auto-scroll to the Nth global search match
  useEffect(() => {
    // Skip if no search term
    if (!primarySearchTerm) {
      lastScrolledSearchTerm.current = '';
      lastScrolledOccurrenceIndex.current = -1;
      return;
    }
    
    // Skip if we already scrolled to this exact occurrence for this sample
    if (
      lastScrolledSampleId.current === sample.id &&
      lastScrolledSearchTerm.current === primarySearchTerm &&
      lastScrolledOccurrenceIndex.current === currentOccurrenceIndex
    ) {
      return;
    }
    
    // Remember what we scrolled to (do this early to prevent re-runs)
    lastScrolledSampleId.current = sample.id;
    lastScrolledSearchTerm.current = primarySearchTerm;
    lastScrolledOccurrenceIndex.current = currentOccurrenceIndex;
    
    // Wait for the DOM to render with highlighted marks, then scroll to the Nth one
    const timeoutId = setTimeout(() => {
      if (messagesContainerRef.current) {
        // Find all highlighted search term elements
        const highlights = messagesContainerRef.current.querySelectorAll('.global-search-highlight');
        const targetHighlight = highlights[currentOccurrenceIndex];
        if (targetHighlight) {
          targetHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (highlights.length > 0) {
          // Fallback to first if index is out of range
          highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }, 50);
    
    return () => clearTimeout(timeoutId);
  }, [sample.id, sample.messages, primarySearchTerm, currentOccurrenceIndex]);

  // Get the message index for the current match (for highlighting)
  const currentMatchMessageIndex = localMatches.length > 0 ? localMatches[currentMatchIndex]?.messageIndex : null;

  // Register message ref
  const setMessageRef = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) {
      messageRefs.current.set(index, element);
    } else {
      messageRefs.current.delete(index);
    }
  }, []);

  // Render a MessageCard. `forCapture` builds the off-screen variant
  // portalled into `captureHost`: themed by the image theme (`opts.dark`)
  // rather than the app theme, and without the URL-share selection ring.
  const renderMessageCard = (
    msg: Message,
    msgIndex: number,
    opts?: { dark?: boolean; forCapture?: boolean },
  ) => (
    <MessageCard
      message={msg}
      index={msgIndex}
      searchConditions={opts?.forCapture ? [] : searchConditions}
      localSearchTerm={opts?.forCapture ? '' : localSearchTerm}
      isCurrentLocalMatch={opts?.forCapture ? false : currentMatchMessageIndex === msgIndex}
      isDarkMode={opts?.dark ?? isDarkMode}
      rolloutN={sample.attributes.rollout_n}
      step={sample.attributes.step}
      filePath={filePath}
      generateLink={generateLink}
      isHighlighted={opts?.forCapture ? false : highlightedMessageIndex === msgIndex}
      highlightedText={opts?.forCapture ? null : (highlightedMessageIndex === msgIndex ? highlightedText : null)}
      onClearHighlight={onClearHighlight}
      messageOccurrenceStart={messageOccurrenceStarts[msgIndex] ?? 0}
      currentOccurrenceIndex={currentOccurrenceIndex}
      gradeQuotes={opts?.forCapture ? [] : gradeQuotes}
      isSharedMode={isSharedMode}
      shareToken={shareToken}
      selectedIndexInFile={selectedIndexInFile}
      ephemeralHighlights={ephemeralHighlights}
      onAddEphemeralHighlight={addEphemeralHighlight}
      onRemoveEphemeralHighlight={removeEphemeralHighlight}
      isPresentationMode={isPresentationMode}
      collapsedRegions={collapsedRegions}
      onAddCollapsedRegion={addCollapsedRegion}
      onRemoveCollapsedRegion={removeCollapsedRegion}
      onUpdateCollapsedRegionLabel={updateCollapsedRegionLabel}
      onHideCollapsedRegion={hideCollapsedRegion}
      onUpdateCollapsedRegionJoin={updateCollapsedRegionJoin}
      onExpandMessageCollapses={expandMessageCollapses}
      wrappedToolCalls={wrappedToolCalls}
      onToggleToolCallWrap={toggleToolCallWrap}
      onCaptureMessage={captureMessage}
      onPreviewMessage={previewMessage}
      onPreviewSelect={handlePreviewSelect}
    />
  );

  return (
    <div className="h-full flex flex-col">
      {/* Local search bar */}
      {isSearchOpen && (
        <div className={`flex items-center gap-2 px-4 py-2 border-b ${isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'}`}>
          <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            search
          </span>
          <input
            type="text"
            value={localSearchTerm}
            onChange={(e) => setLocalSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search in this chat..."
            className={`flex-1 px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500 ${
              isDarkMode ? 'bg-gray-700 border-gray-600 text-gray-200 placeholder-gray-500' : 'bg-white border-gray-300'
            }`}
            autoFocus
          />
          {localSearchTerm && (
            <span className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {localMatches.length > 0 
                ? `${currentMatchIndex + 1}/${localMatches.length}`
                : 'No matches'
              }
            </span>
          )}
          <button
            onClick={() => navigateMatch('prev')}
            disabled={localMatches.length === 0}
            className={`p-1 rounded disabled:opacity-50 ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            title="Previous match (Shift+Enter)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              keyboard_arrow_up
            </span>
          </button>
          <button
            onClick={() => navigateMatch('next')}
            disabled={localMatches.length === 0}
            className={`p-1 rounded disabled:opacity-50 ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            title="Next match (Enter)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              keyboard_arrow_down
            </span>
          </button>
          <button
            onClick={() => {
              setIsSearchOpen(false);
              setLocalSearchTerm('');
            }}
            className={`p-1 rounded ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            title="Close search (Esc)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              close
            </span>
          </button>
        </div>
      )}

      {/* Presentation Mode toolbar — replaces the search-toggle row. */}
      {isPresentationMode && (
        <div className={`flex flex-wrap justify-between items-center gap-x-3 gap-y-1 px-4 py-1.5 border-b ${isDarkMode ? 'border-gray-700 bg-gray-800/60' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-flex items-center gap-1 font-medium ${isDarkMode ? 'text-sky-300' : 'text-sky-700'}`}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>slideshow</span>
              Presentation
            </span>
            {collapsedRegions.length > 0 && (
              <>
                <span className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>
                  {collapsedRegions.length} collapsed
                </span>
                <button
                  onClick={undoCollapse}
                  title="Undo last collapse (Ctrl+Z)"
                  className={`px-1.5 py-0.5 rounded ${isDarkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-200'}`}
                >
                  Undo
                </button>
                <button
                  onClick={clearCollapsedRegions}
                  title="Expand all collapsed spans"
                  className={`px-1.5 py-0.5 rounded ${isDarkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-200'}`}
                >
                  Expand all
                </button>
              </>
            )}
            <span className={isDarkMode ? 'text-gray-500' : 'text-gray-400'}>
              Select text → Collapse C · Isolate O · Highlight H · Bold B · Italic I · hover + P to capture · drop a PNG
            </span>
          </div>
        </div>
      )}

      {/* Search toggle button (when search is closed) */}
      {!isSearchOpen && !isPresentationMode && (
        <div className={`flex justify-between items-center px-4 py-1 border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          {/* Ephemeral-highlights count + clear (left) — only when any exist */}
          {ephemeralHighlights.length > 0 ? (
            <div className="flex items-center gap-2 text-xs">
              <span className={`inline-flex items-center gap-1 ${isDarkMode ? 'text-fuchsia-300' : 'text-fuchsia-700'}`}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>ink_highlighter</span>
                {ephemeralHighlights.length} highlight{ephemeralHighlights.length === 1 ? '' : 's'}
              </span>
              <button
                onClick={clearEphemeralHighlights}
                className={`px-1.5 py-0.5 rounded ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
                title="Clear all highlights (session only)"
              >
                Clear
              </button>
            </div>
          ) : <span />}
          <button
            onClick={() => setIsSearchOpen(true)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
              isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
            title="Search in chat (Ctrl+F)"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>search</span>
            Search chat
          </button>
        </div>
      )}

      {/* Grades display */}
      <GradesDisplay
        grades={sample.grades}
        selectedMetric={selectedGradeMetric}
        onSelectMetric={onSelectGradeMetric || (() => {})}
        onScrollToQuote={(messageIndex, quoteIdx) => {
          // Wait for the new selectedMetric state to commit and for
          // MessageCards to render purple `.grade-quote-mark` elements.
          // Two rAFs (layout → paint → read) is enough; the previous
          // setTimeout(100) was a guess that missed on slower renders.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const container = messagesContainerRef.current;
            if (!container) return;
            const marks = container.querySelectorAll<HTMLElement>('mark.grade-quote-mark');
            if (marks.length > 0) {
              // Target the specific mark by its index in the sorted quote
              // list. Falls back to the nearest mark inside the requested
              // message if the index is out of range.
              const target = marks[quoteIdx ?? 0];
              if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
              }
            }
            // Fallback: no marks rendered (e.g. quote text didn't match) —
            // at least bring the containing message into view.
            const messageElement = messageRefs.current.get(messageIndex);
            if (messageElement) {
              messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }));
        }}
        isDarkMode={isDarkMode}
        currentQuoteIndex={currentQuoteIndex}
        onQuoteIndexChange={setCurrentQuoteIndex}
      />

      {/* Messages area — in presentation mode it also accepts a dropped PNG
          (a previously-exported capture) to navigate back to its source. */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4"
        onDragOver={isPresentationMode ? (e) => e.preventDefault() : undefined}
        onDrop={isPresentationMode ? handlePngDrop : undefined}
      >
        {sample.messages.map((message, index) => (
          <div key={index} ref={(el) => setMessageRef(index, el)}>
            {renderMessageCard(message, index)}
          </div>
        ))}
      </div>

      {/* Off-screen capture card — the active message rendered in the image
          theme, portalled outside #root. Captures and the left-panel preview
          clone from here, so the exported image stays independent of the
          app UI theme. */}
      {isPresentationMode && activeIndex !== null && sample.messages[activeIndex] != null &&
        createPortal(
          renderMessageCard(sample.messages[activeIndex], activeIndex, {
            dark: imageTheme === 'dark',
            forCapture: true,
          }),
          captureHost,
        )}

      {/* Sample metadata footer */}
      <div className={`border-t p-3 ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
        <div className={`flex flex-wrap gap-4 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Step:</span>{' '}
            <span className="font-semibold">{sample.attributes.step}</span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Reward:</span>{' '}
            <span className={`font-semibold ${sample.attributes.reward >= 0 ? (isDarkMode ? 'text-green-400' : 'text-green-600') : (isDarkMode ? 'text-red-400' : 'text-red-600')}`}>
              {sample.attributes.reward}
            </span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Rollout:</span>{' '}
            <span className="font-semibold">{sample.attributes.rollout_n}</span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Source:</span>{' '}
            <span className="font-semibold">{sample.attributes.data_source}</span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Timestamp:</span>{' '}
            <span className="font-semibold">{sample.timestamp}</span>
          </div>
        </div>
      </div>

      {preview && (
        <CapturePreviewModal
          imageUrl={preview.url}
          isDarkMode={isDarkMode}
          onCopy={() => { copyImageToClipboard(preview.blob, preview.caption); }}
          onDownload={() => downloadBlob(preview.blob, 'rollout-capture.png')}
          onClose={closePreview}
        />
      )}
    </div>
  );
}
