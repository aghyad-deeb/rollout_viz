import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { Sample, Message, SearchCondition, Quote, EphemeralHighlight, CollapsedRegion, RegionLocator, CaptureStyle, ExportWidth, FontSize } from '../../types';
import { displayMessages } from '../../utils/toolEcho';
import { MessageCard } from './MessageCard';
import { GradesDisplay } from './GradesDisplay';
import { Minimap } from './Minimap';
import { countMessageOccurrences, buildSearchCorpus } from '../../utils/parseContent';
import { findAllMatchesCI } from '../../utils/textMatch';
import { extractHighlightAnchor } from '../../utils/textSnippet';
import { captureCardToPng, capturePageWidthPt, copyImageToClipboard, downloadBlob, encodeImage, resolveCaptureFontScale } from '../../utils/captureImage';
import { readPngTextChunks, stripPngTextChunks } from '../../utils/pngMetadata';
import { applyPresentationDraft, type PresentationMessageDrafts } from '../../utils/presentationDraft';
import { CapturePreviewModal } from './CapturePreviewModal';
import { buildPublicUrl, safeSameOriginRolloutUrl } from '../../config';
import { formatTimestamp } from '../../utils/formatTimestamp';
import { latestJudgeEntry } from '../../utils/humanGrades';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Stable default for the presentationDrafts prop. An inline `= {}` default
// would mint a new identity on every render, invalidating the
// displayedMessages memo and re-arming the preview-capture effect in a loop
// whenever the pending callback triggers a parent re-render.
const EMPTY_DRAFTS: PresentationMessageDrafts = {};

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
  /** Figure style for captures. 'paper' also forces the clone LIGHT. */
  captureStyle?: CaptureStyle;
  onPresentationPreview?: (url: string | null, blob?: Blob | null) => void;
  // Fires true while a fresh left-panel preview render is pending (debounce +
  // capture), false once the preview is current again — lets the preview
  // panel mark itself stale and hold Copy/Download until the render lands.
  onPreviewPending?: (pending: boolean) => void;
  presentationDrafts?: PresentationMessageDrafts;
  presentationActiveIndex?: number | null;
  onPresentationActiveIndexChange?: (index: number | null) => void;
  // Exits Presentation Mode — wired to the toolbar "Exit (Esc)" button and
  // a window Escape listener (guarded so modals / menus / inputs win).
  onExitPresentationMode?: () => void;
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
  captureStyle = 'screen',
  onPresentationPreview,
  onPreviewPending,
  presentationDrafts = EMPTY_DRAFTS,
  presentationActiveIndex = null,
  onPresentationActiveIndexChange,
  onExitPresentationMode,
}: ChatViewProps) {
  // Extract quotes from the selected grade metric
  const gradeQuotes = useMemo((): Quote[] => {
    if (!selectedGradeMetric || !sample.grades || !sample.grades[selectedGradeMetric]) {
      return [];
    }
    // Quotes come from the latest JUDGE entry — human confirm/dispute entries
    // append to the same list but never carry quotes, and must not blank the
    // judge's evidence.
    const latestGrade = latestJudgeEntry(sample.grades[selectedGradeMetric]);
    const quotes = latestGrade?.quotes || [];
    // Sorted by (message_index, start) — the SAME order GradesDisplay uses
    // for its quote pager, so a quote's index here is its pager position.
    // MessageCard stamps that index on each rendered mark, which is what
    // keeps navigation aligned even when some quote can't be located in the
    // transcript (inexact judge quoting).
    return [...quotes].sort((a, b) => {
      if (a.message_index !== b.message_index) return a.message_index - b.message_index;
      return a.start - b.start;
    });
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

  const displayedMessages = useMemo(() => {
    const base = isPresentationMode
      ? sample.messages.map((message, index) => applyPresentationDraft(message, presentationDrafts[index]))
      : sample.messages;
    // Some producers echo the executed command as the first line(s) of the
    // tool RESULT — the assistant's CALL band already shows it. `displayMessages`
    // is the SHARED strip (utils/toolEcho.ts): LeftPanel's global-search
    // matching and match counts run through the same mapping, so the table's
    // count and the transcript's marks can never disagree. The original string
    // is preserved on raw_content and the data on disk is untouched.
    return displayMessages(base);
  }, [isPresentationMode, presentationDrafts, sample.messages]);

  // The conversation's first user turn is the task statement — MessageCard
  // gives it a 'TASK' running head and a step-up in body size. -1 when the
  // rollout has no user message at all.
  const taskMessageIndex = useMemo(
    () => displayedMessages.findIndex((m) => m.role === 'user'),
    [displayedMessages],
  );

  // Calculate the starting occurrence index for each message (cumulative count).
  // Uses the same normalized text and field scoping as MessageCard highlights.
  const messageOccurrenceStarts = useMemo(() => {
    const starts: number[] = [];
    let cumulativeCount = 0;
    const activeConditions = searchConditions.filter(c => c.operator === 'contains' && c.term.trim());

    displayedMessages.forEach((message) => {
      starts.push(cumulativeCount);
      cumulativeCount += countMessageOccurrences(message, activeConditions);
    });
    
    return starts;
  }, [displayedMessages, searchConditions]);

  const [localSearchTerm, setLocalSearchTerm] = useState('');
  const [localMatchCursor, setLocalMatchCursor] = useState({ term: '', index: 0 });
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  // Bulk expand/collapse for all message cards. The version bump tells each
  // card a new bulk action fired (value alone can repeat).
  const [expandAllSignal, setExpandAllSignal] = useState({ value: true, version: 0 });
  const [quoteCursor, setQuoteCursor] = useState<{ metric: string | undefined; index: number }>({ metric: undefined, index: 0 });
  // Ephemeral, session-only highlights: not persisted anywhere, cleared
  // whenever the user navigates to a different sample.
  const [ephemeralHighlights, setEphemeralHighlights] = useState<EphemeralHighlight[]>([]);
  // Per-tool-call soft-wrap state, lifted here (not MessageCard-local) so the
  // off-screen capture card mirrors it. Keys are `"${messageIndex}:${tcIdx}"`.
  const [wrappedToolCalls, setWrappedToolCalls] = useState<Set<string>>(new Set());
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastScrolledSampleId = useRef<number | null>(null);
  const lastScrolledSearchTerm = useRef<string>('');
  // Last local (Ctrl+F) term we auto-scrolled to — mirrors
  // lastScrolledSearchTerm so typing a term jumps to its first match once.
  const lastScrolledLocalTerm = useRef<string>('');

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
  // The modal's blob and the SETTINGS THAT PRODUCED IT travel together. The
  // settings row stays live behind the modal, so deriving the download label /
  // format / PDF page geometry from current state mislabeled and mis-sized an
  // artifact that had already been rasterized under the old ones (flip to
  // Paper with a screen preview open and Download handed you screen pixels
  // inside a 234pt "column" page). Snapshotting them into the same state that
  // holds the blob makes the modal honest by construction.
  const [preview, setPreview] = useState<{
    url: string;
    blob: Blob;
    caption: string;
    filename: string;
    opts: { captureStyle: CaptureStyle; exportWidth: ExportWidth; imageTheme: 'light' | 'dark' };
  } | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  // Presentation-toolbar "?" shortcuts popover (Escape / outside-click close).
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const helpWrapRef = useRef<HTMLDivElement>(null);
  // Per-card capture feedback: busy while rendering, then done / fallback /
  // error for ~2s. Keyed by message index so React.memo skips other cards.
  // `captureStatusRef` mirrors the state so captureMessage can read the
  // current value without invalidating its useCallback identity.
  const [captureStatus, setCaptureStatus] = useState<Record<number, 'busy' | 'done' | 'fallback' | 'error'>>({});
  const captureStatusRef = useRef(captureStatus);
  const captureStatusTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    captureStatusRef.current = captureStatus;
  }, [captureStatus]);
  // Clear any pending status-reset timers on unmount.
  useEffect(() => {
    const timers = captureStatusTimersRef.current;
    return () => { timers.forEach((t) => clearTimeout(t)); };
  }, []);
  // The card under the pointer (kept when the pointer leaves, so it falls
  // back to the last one touched) — subject of the left-panel live preview.
  // The message being captured/previewed: index of the card last clicked.
  const [uncontrolledActiveIndex, setUncontrolledActiveIndex] = useState<number | null>(null);
  const activeIndex = onPresentationActiveIndexChange
    ? presentationActiveIndex ?? null
    : uncontrolledActiveIndex;
  const leftPreviewUrlRef = useRef<string | null>(null);
  // The preview effect reads these callbacks through refs instead of listing
  // them as deps. This is load-bearing: a parent passing inline arrows would
  // otherwise re-trigger the effect after every completed capture (state
  // update → new identity → effect re-runs) and loop forever, re-capturing
  // and pinning the "Updating preview…" badge on.
  const onPresentationPreviewRef = useRef(onPresentationPreview);
  const onPreviewPendingRef = useRef(onPreviewPending);
  useEffect(() => {
    onPresentationPreviewRef.current = onPresentationPreview;
    onPreviewPendingRef.current = onPreviewPending;
  }, [onPresentationPreview, onPreviewPending]);
  const setActivePresentationIndex = useCallback((index: number | null) => {
    if (!onPresentationActiveIndexChange) setUncontrolledActiveIndex(index);
    onPresentationActiveIndexChange?.(index);
  }, [onPresentationActiveIndexChange]);
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
  // A paper figure is always light (it sits on the printed page), so the
  // dark class is withheld there regardless of the image-theme setting —
  // which the settings UI shows locked while the paper style is on.
  const captureDark = imageTheme === 'dark' && captureStyle !== 'paper';
  useEffect(() => {
    captureHost.classList.toggle('dark', captureDark);
  }, [captureHost, captureDark]);
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

  // Preview-modal downloads. PNG is the raw capture; PDF re-wraps that exact
  // raster (losslessly) in a page sized to the figure's nominal physical
  // width, which is what makes a paper figure droppable into LaTeX at 1:1.
  const downloadPreviewPng = useCallback(() => {
    if (preview) downloadBlob(preview.blob, preview.filename);
  }, [preview]);

  const downloadPreviewPdf = useCallback(async () => {
    if (!preview) return;
    try {
      // Page geometry comes from the SNAPSHOT the blob was rendered under,
      // never from the live settings row behind the modal.
      const pdf = await encodeImage(
        preview.blob,
        'pdf',
        capturePageWidthPt(preview.opts.captureStyle, preview.opts.exportWidth),
      );
      downloadBlob(pdf, preview.filename.replace(/\.png$/, '.pdf'));
    } catch {
      downloadBlob(preview.blob, preview.filename);   // never leave the click dead
    }
  }, [preview]);

  // Close the capture-preview modal, freeing its object URL.
  const closePreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  }, []);


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

  // The Escape exit calls this prop, which triggers a parent state update —
  // read it through a ref (synced by its own effect) so an inline arrow from
  // the parent can't re-arm the listener effect on every render.
  const onExitPresentationModeRef = useRef(onExitPresentationMode);
  useEffect(() => {
    onExitPresentationModeRef.current = onExitPresentationMode;
  }, [onExitPresentationMode]);

  // Escape exits Presentation Mode. Guards, in order: the capture-preview
  // modal owns Escape while open (its own listener closes it and does not
  // stopPropagation); an open elision-pill menu owns Escape; typing contexts
  // are left alone; the shortcuts popover closes itself first (its own
  // Escape listener below).
  useEffect(() => {
    if (!isPresentationMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (preview) return;
      if (document.querySelector('[data-testid="elision-pill-menu"]')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (isHelpOpen) return;
      onExitPresentationModeRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPresentationMode, preview, isHelpOpen]);

  // Shortcuts popover: Escape or a click outside the "?" button / popover
  // wrapper dismisses it.
  useEffect(() => {
    if (!isHelpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsHelpOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (helpWrapRef.current && !helpWrapRef.current.contains(e.target as Node)) {
        setIsHelpOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [isHelpOpen]);

  // Resolve the capture font multiplier: the user's font-size preset in the
  // screen style, the derived final-size (9pt) scale in the paper style.
  const fontScale = resolveCaptureFontScale(captureStyle, fontSize);

  // Render a message card to a PNG. We strip rollout-viz text metadata from
  // new exports so shared captures do not carry hidden source paths or origins.
  //
  // `flushSync` commits the off-screen portal card for `messageIndex` (in
  // the image theme) synchronously, so the capture clones the right card
  // whether it was reached by a click — which pre-sets `activeIndex` — or
  // by the `P` shortcut on a merely-hovered card.
  const buildCapturePng = useCallback(async (messageIndex: number) => {
    flushSync(() => setActivePresentationIndex(messageIndex));
    const cardEl = captureHost.firstElementChild as HTMLElement | null;
    if (!cardEl) throw new Error('capture card is not mounted');
    // The settings this raster is rendered under, captured HERE so anything
    // downstream (the preview modal's label / format / PDF page size) can
    // describe the artifact it actually has rather than the live controls.
    const opts = { captureStyle, exportWidth, imageTheme };
    const rawPng = await captureCardToPng(cardEl, { ...opts, fontScale });
    const png = await stripPngTextChunks(rawPng, ['rollout-viz']);
    const caption =
      `${sample.attributes.experiment_name} · rollout ${sample.attributes.rollout_n}` +
      ` · step ${sample.attributes.step}`;
    // Descriptive filename for the download paths (clipboard fallback and
    // the preview modal's Download button).
    const filename =
      `rollout-${sample.attributes.rollout_n}-step${sample.attributes.step}-msg${messageIndex + 1}.png`;
    return { png, caption, filename, opts };
  }, [captureHost, exportWidth, imageTheme, captureStyle, fontScale, sample.attributes, setActivePresentationIndex]);

  // P / camera button: capture straight to the clipboard. Reports per-card
  // status (busy → done / fallback / error) so the 0.5-2s render + clipboard
  // write isn't silent; the status clears itself after ~2s.
  const captureMessage = useCallback(async (messageIndex: number) => {
    if (captureStatusRef.current[messageIndex] === 'busy') return;
    const setStatus = (status: 'busy' | 'done' | 'fallback' | 'error') => {
      setCaptureStatus((prev) => ({ ...prev, [messageIndex]: status }));
    };
    setStatus('busy');
    try {
      const { png, caption, filename } = await buildCapturePng(messageIndex);
      const copied = await copyImageToClipboard(png, caption, filename);
      setStatus(copied ? 'done' : 'fallback');
    } catch (err) {
      console.error('[presentation] capture failed', err);
      setStatus('error');
    }
    // Clear the terminal status after ~2s (copiedLink-style feedback).
    const existing = captureStatusTimersRef.current.get(messageIndex);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      captureStatusTimersRef.current.delete(messageIndex);
      setCaptureStatus((prev) => {
        const next = { ...prev };
        delete next[messageIndex];
        return next;
      });
    }, 2000);
    captureStatusTimersRef.current.set(messageIndex, timer);
  }, [buildCapturePng]);

  // Preview button: render the same PNG and open it in a modal so the user
  // can check it before copying.
  const previewMessage = useCallback(async (messageIndex: number) => {
    try {
      const { png, caption, filename, opts } = await buildCapturePng(messageIndex);
      const url = URL.createObjectURL(png);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreview({ url, blob: png, caption, filename, opts });
    } catch (err) {
      console.error('[presentation] preview failed', err);
    }
  }, [buildCapturePng]);

  // A MessageCard reports its index when clicked; that card becomes the
  // subject of the off-screen capture portal and the left-panel preview.
  const handlePreviewSelect = useCallback((messageIndex: number) => {
    setActivePresentationIndex(messageIndex);
  }, [setActivePresentationIndex]);

  // Keep the left-panel preview in sync with the active (clicked) card.
  // Reads the off-screen portal card — rendered in the image theme — so the
  // preview matches the eventual capture exactly. Debounced so rapid
  // collapses / setting changes coalesce.
  useEffect(() => {
    if (!isPresentationMode || activeIndex === null || !onPresentationPreviewRef.current) {
      // No render scheduled → whatever preview is shown is not "behind".
      onPreviewPendingRef.current?.(false);
      return;
    }
    // The preview on screen is now stale until this render lands. Cleared on
    // every completion path below (NOT in the effect cleanup — that runs
    // before the next body and would flicker on each keystroke).
    onPreviewPendingRef.current?.(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      const cardEl = captureHost.firstElementChild as HTMLElement | null;
      if (!cardEl) {
        onPreviewPendingRef.current?.(false);
        return;
      }
      try {
        const raw = await captureCardToPng(cardEl, { exportWidth, imageTheme, captureStyle, fontScale });
        const blob = await stripPngTextChunks(raw, ['rollout-viz']);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (leftPreviewUrlRef.current) URL.revokeObjectURL(leftPreviewUrlRef.current);
        leftPreviewUrlRef.current = url;
        onPresentationPreviewRef.current?.(url, blob);
        onPreviewPendingRef.current?.(false);
      } catch {
        /* best-effort — leave the last preview in place */
        if (!cancelled) onPreviewPendingRef.current?.(false);
      }
    }, 380);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isPresentationMode, activeIndex, displayedMessages, collapsedRegions, ephemeralHighlights, wrappedToolCalls, exportWidth, imageTheme, captureStyle, fontScale, captureHost]);

  // Free the left-panel preview URL on unmount; a pending flag must not
  // outlive the component that would clear it.
  useEffect(() => () => {
    if (leftPreviewUrlRef.current) URL.revokeObjectURL(leftPreviewUrlRef.current);
    onPreviewPendingRef.current?.(false);
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
      const safeUrl = meta.url ? safeSameOriginRolloutUrl(meta.url) : null;
      if (safeUrl) window.location.href = safeUrl;
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
  
  const currentQuoteIndex = quoteCursor.metric === selectedGradeMetric ? quoteCursor.index : 0;
  const handleQuoteIndexChange = useCallback((index: number) => {
    setQuoteCursor({ metric: selectedGradeMetric, index });
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
    displayedMessages.forEach((message, messageIndex) => {
      const corpus = buildSearchCorpus(message);
      const found = findAllMatchesCI(corpus, term);
      for (let i = 0; i < found.length; i++) {
        matches.push({ messageIndex, matchIndex: i });
      }
    });
    return matches;
  }, [displayedMessages, localSearchTerm]);

  // Starting local-match index for each message (cumulative corpus count) —
  // mirrors messageOccurrenceStarts so MessageCard can style the current
  // local match distinctly from the other green matches.
  const localOccurrenceStarts = useMemo(() => {
    const term = localSearchTerm.trim();
    const starts: number[] = [];
    let cumulativeCount = 0;
    displayedMessages.forEach((message) => {
      starts.push(cumulativeCount);
      if (term) cumulativeCount += findAllMatchesCI(buildSearchCorpus(message), term).length;
    });
    return starts;
  }, [displayedMessages, localSearchTerm]);

  const currentMatchIndex = localMatches.length === 0
    ? 0
    : Math.min(
      localMatchCursor.term === localSearchTerm ? localMatchCursor.index : 0,
      localMatches.length - 1,
    );

  // Scroll to the exact current match: the Nth `.local-search-mark` in
  // document order (MessageCard tags one per match, first segment only) —
  // mirrors the global-search machinery. Falls back to the containing
  // message when the mark isn't rendered (e.g. collapsed away).
  const scrollToMatch = useCallback((matchIdx: number) => {
    if (localMatches.length === 0 || matchIdx >= localMatches.length) return;

    const marks = messagesContainerRef.current?.querySelectorAll('mark.local-search-mark');
    const mark = marks?.[matchIdx];
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const match = localMatches[matchIdx];
    const messageElement = messageRefs.current.get(match.messageIndex);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [localMatches]);

  // Jump to the first match as soon as a (new) term has matches — once per
  // term, without touching the cursor, so Enter still walks from the top.
  useEffect(() => {
    const term = localSearchTerm.trim();
    if (!term) {
      lastScrolledLocalTerm.current = '';
      return;
    }
    if (localMatches.length === 0 || lastScrolledLocalTerm.current === term) return;
    lastScrolledLocalTerm.current = term;
    scrollToMatch(0);
  }, [localSearchTerm, localMatches, scrollToMatch]);

  // Navigate to next/prev match
  const navigateMatch = useCallback((direction: 'next' | 'prev') => {
    if (localMatches.length === 0) return;
    
    let newIndex: number;
    if (direction === 'next') {
      newIndex = (currentMatchIndex + 1) % localMatches.length;
    } else {
      newIndex = (currentMatchIndex - 1 + localMatches.length) % localMatches.length;
    }
    
    setLocalMatchCursor({ term: localSearchTerm, index: newIndex });
    scrollToMatch(newIndex);
  }, [currentMatchIndex, localMatches.length, localSearchTerm, scrollToMatch]);

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

  // Toggle search with Ctrl/Cmd + F. When the bar is already open, refocus
  // and select the input so a second Ctrl+F starts a fresh query. Read via
  // a ref so the window listener binds once.
  const isSearchOpenRef = useRef(isSearchOpen);
  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        if (isSearchOpenRef.current) {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else {
          setIsSearchOpen(true);
        }
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
        url = buildPublicUrl(p);
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

  // Minimap click → bring that message to the top of the view. Stable
  // identity (reads the ref map) so the memoized Minimap never re-renders
  // for it.
  const scrollMessageIntoView = useCallback((index: number) => {
    messageRefs.current.get(index)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
  //
  // The capture card is KEYED by message index so switching the active card
  // remounts it. Without that key React reuses one instance and its
  // isExpanded / showFull state leaks from the previously captured message —
  // with system cards collapsed by default, that exported a header-only strip
  // (or a card whose reveal state disagreed with the on-screen one).
  const renderMessageCard = (
    msg: Message,
    msgIndex: number,
    opts?: { dark?: boolean; forCapture?: boolean; isChainedToolResult?: boolean },
  ) => (
    <MessageCard
      key={opts?.forCapture ? `capture-${msgIndex}` : undefined}
      message={msg}
      index={msgIndex}
      searchConditions={opts?.forCapture ? [] : searchConditions}
      localSearchTerm={opts?.forCapture ? '' : localSearchTerm}
      localOccurrenceStart={localOccurrenceStarts[msgIndex] ?? 0}
      currentLocalMatchIndex={opts?.forCapture ? -1 : currentMatchIndex}
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
      captureStatus={opts?.forCapture ? undefined : captureStatus[msgIndex]}
      // The !forCapture guard keeps the off-screen portal clone from
      // double-firing the P-shortcut capture.
      isPresentationActive={!opts?.forCapture && isPresentationMode && activeIndex === msgIndex}
      expandAllSignal={opts?.forCapture ? undefined : expandAllSignal}
      isTaskMessage={msgIndex === taskMessageIndex}
      isChainedToolResult={opts?.isChainedToolResult ?? false}
      // Forces the clone open (expanded + fully revealed, no clamp) so the
      // exported figure is the whole message regardless of the role default.
      forCapture={opts?.forCapture ?? false}
    />
  );

  // Keycap chip styling for the presentation-toolbar hints.
  const kbdCls = `px-1 rounded border font-mono text-[10px] ${
    isDarkMode ? 'border-gray-600 bg-gray-800 text-gray-300' : 'border-gray-300 bg-white text-gray-700'
  }`;

  return (
    <div className="h-full flex flex-col">
      {/* Local search bar */}
      {isSearchOpen && (
        <div className={`flex items-center gap-2 px-4 py-2 border-b ${isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'}`}>
          <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            search
          </span>
          <input
            ref={searchInputRef}
            type="text"
            value={localSearchTerm}
            onChange={(e) => setLocalSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search in this chat..."
            className={`flex-1 min-w-[180px] px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500 ${
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
            aria-label="Previous match (Shift+Enter)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} aria-hidden="true">
              keyboard_arrow_up
            </span>
          </button>
          <button
            onClick={() => navigateMatch('next')}
            disabled={localMatches.length === 0}
            className={`p-1 rounded disabled:opacity-50 ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            title="Next match (Enter)"
            aria-label="Next match (Enter)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} aria-hidden="true">
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
            aria-label="Close search (Esc)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} aria-hidden="true">
              close
            </span>
          </button>
        </div>
      )}

      {/* Presentation Mode toolbar — replaces the search-toggle row. */}
      {isPresentationMode && (
        <div className={`flex flex-wrap justify-between items-center gap-x-3 gap-y-1 px-4 py-1.5 border-b ${isDarkMode ? 'border-gray-700 bg-gray-800/60' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs">
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
                <span className={isDarkMode ? 'text-gray-500' : 'text-gray-400'}>
                  right-click [...] to edit/hide
                </span>
              </>
            )}
            <span className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              <span className="whitespace-nowrap">Select text →</span>
              {([['Collapse', 'C'], ['Isolate', 'O'], ['Highlight', 'H'], ['Bold', 'B'], ['Italic', 'I']] as const).map(([label, key]) => (
                <span key={key} className="whitespace-nowrap inline-flex items-center gap-1">
                  {label} <kbd className={kbdCls}>{key}</kbd>
                </span>
              ))}
              <span className="whitespace-nowrap inline-flex items-center gap-1">
                <kbd className={kbdCls}>P</kbd> capture
              </span>
            </span>
            <div ref={helpWrapRef} className="relative presentation-chrome">
              <button
                type="button"
                aria-label="Presentation shortcuts help"
                title="Presentation shortcuts help"
                onClick={() => setIsHelpOpen((o) => !o)}
                className={`flex items-center justify-center w-5 h-5 rounded-full border text-[10px] font-semibold leading-none ${
                  isDarkMode
                    ? 'border-gray-600 text-gray-300 hover:bg-gray-700'
                    : 'border-gray-300 text-gray-500 hover:bg-gray-200'
                }`}
              >
                ?
              </button>
              {isHelpOpen && (
                <div
                  data-testid="presentation-help-popover"
                  className={`presentation-chrome absolute left-0 top-full mt-1.5 z-50 w-80 rounded-md border p-3 shadow-lg text-xs leading-relaxed ${
                    isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200' : 'bg-white border-gray-300 text-gray-700'
                  }`}
                >
                  <ul className="space-y-1 list-disc pl-4">
                    <li><b>C</b> / <b>O</b> / <b>H</b> / <b>B</b> / <b>I</b> act on the current selection: Collapse, Isolate, Highlight, Bold, Italic.</li>
                    <li><b>Shift+C</b> isolates. Isolate keeps the selection visible and collapses everything else in the message.</li>
                    <li><b>P</b> captures the hovered (or active) card to the clipboard.</li>
                    <li><b>Ctrl+Z</b> undoes the last collapse.</li>
                    <li>Right-click a <b>[...]</b> pill for label / hide / same-line options.</li>
                    <li>Drop an exported PNG onto the chat to jump back to its source rollout.</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onExitPresentationMode?.()}
            title="Exit presentation mode (Esc)"
            className={`presentation-chrome px-2 py-0.5 rounded text-xs ${
              isDarkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-200'
            }`}
          >
            Exit (Esc)
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
            // Marks are stamped with their quote's index in the sorted quote
            // list (data-quote-idx), so targeting is exact even when OTHER
            // quotes couldn't be located in the transcript — a positional
            // marks[i] lookup would silently shift onto the wrong quote.
            const target = container.querySelector<HTMLElement>(
              `mark.grade-quote-mark[data-quote-idx="${quoteIdx ?? 0}"]`,
            );
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return;
            }
            // Fallback: this quote's text didn't match the transcript (the
            // judge quoted inexactly) — at least bring the containing
            // message into view.
            const messageElement = messageRefs.current.get(messageIndex);
            if (messageElement) {
              messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }));
        }}
        isDarkMode={isDarkMode}
        currentQuoteIndex={currentQuoteIndex}
        onQuoteIndexChange={handleQuoteIndexChange}
      />

      {/* Messages area — in presentation mode it also accepts a dropped PNG
          (a previously-exported capture) to navigate back to its source.
          The relative wrapper hosts the floating toolbar cluster as a
          SIBLING of the scroll container: the Cmd+C handler maps messages
          via `:scope > div` on the inner div, so nothing else may live
          inside it. */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={messagesContainerRef}
          className={`h-full overflow-y-auto pt-10 pb-4 pl-4 pr-7 transcript-surface ${isPresentationMode ? 'custom-scrollbar' : 'scrollbar-none'}`}
          onDragOver={isPresentationMode ? (e) => e.preventDefault() : undefined}
          onDrop={isPresentationMode ? handlePngDrop : undefined}
        >
          {/* Role-aware rhythm instead of a uniform gap: a tool result hugs
              the assistant call that produced it (6px) — but ONLY that; a
              tool result following another tool result keeps the full gap,
              or two same-tinted cards fuse into one apparent card with a
              clamp pill floating in its middle. Assistant turns open a
              visual paragraph (24px); everything else keeps 16px. Wrappers
              stay direct children — the Cmd+C `:scope > div` mapping and
              message indices are untouched. */}
          {displayedMessages.map((message, index) => {
            const isChainedToolResult =
              message.role === 'tool' && displayedMessages[index - 1]?.role === 'assistant';
            return (
              <div
                key={index}
                ref={(el) => setMessageRef(index, el)}
                className={
                  index === 0 ? undefined
                    : isChainedToolResult ? 'mt-1 ml-6'
                      : message.role === 'assistant' ? 'mt-7'
                        : 'mt-4'
                }
              >
                {renderMessageCard(message, index, { isChainedToolResult })}
              </div>
            );
          })}
        </div>

        {/* Conversation minimap — slim overlay rail on the right edge, a
            SIBLING of the scroll container (the `:scope > div` contract
            above forbids putting it inside). Hidden in Presentation Mode;
            it also hides itself when the transcript fits without scrolling.
            The off-screen capture render clones individual cards only, so
            it can never include this. */}
        {!isPresentationMode && (
          <Minimap
            messages={displayedMessages}
            containerRef={messagesContainerRef}
            isDarkMode={isDarkMode}
            searchConditions={searchConditions}
            localSearchTerm={localSearchTerm}
            gradeQuotes={gradeQuotes}
            highlightedMessageIndex={highlightedMessageIndex}
            onMessageClick={scrollMessageIntoView}
          />
        )}

        {/* Floating toolbar cluster — collapse/expand-all + search (and the
            ephemeral-highlights count) overlaid on the top-right corner
            instead of spending a full-width row. */}
        {!isSearchOpen && !isPresentationMode && (
          <div
            className={`absolute top-1 right-9 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-md border backdrop-blur-sm shadow-sm ${
              isDarkMode ? 'bg-[#16191d]/85 border-gray-700' : 'bg-white/85 border-gray-200'
            }`}
          >
            {ephemeralHighlights.length > 0 && (
              <>
                <span className={`inline-flex items-center gap-1 text-xs whitespace-nowrap ${isDarkMode ? 'text-fuchsia-300' : 'text-fuchsia-700'}`}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>ink_highlighter</span>
                  {ephemeralHighlights.length} highlight{ephemeralHighlights.length === 1 ? '' : 's'}
                </span>
                <button
                  onClick={clearEphemeralHighlights}
                  className={`px-1.5 py-0.5 text-xs rounded ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
                  title="Clear all highlights (session only)"
                >
                  Clear
                </button>
                <div className={`w-px h-4 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-200'}`} />
              </>
            )}
            <button
              onClick={() => setExpandAllSignal(s => ({ value: false, version: s.version + 1 }))}
              className={`w-[26px] h-[26px] flex items-center justify-center rounded ${
                isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
              }`}
              title="Collapse all messages"
              aria-label="Collapse all messages"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">unfold_less</span>
            </button>
            <button
              onClick={() => setExpandAllSignal(s => ({ value: true, version: s.version + 1 }))}
              className={`w-[26px] h-[26px] flex items-center justify-center rounded ${
                isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
              }`}
              title="Expand all messages"
              aria-label="Expand all messages"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">unfold_more</span>
            </button>
            <button
              onClick={() => setIsSearchOpen(true)}
              className={`w-[26px] h-[26px] flex items-center justify-center rounded ${
                isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
              }`}
              title="Search in chat (Ctrl+F)"
              aria-label="Search chat"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">search</span>
            </button>
          </div>
        )}
      </div>

      {/* Off-screen capture card — the active message rendered in the image
          theme, portalled outside #root. Captures and the left-panel preview
          clone from here, so the exported image stays independent of the
          app UI theme. */}
      {isPresentationMode && activeIndex !== null && displayedMessages[activeIndex] != null &&
        createPortal(
          renderMessageCard(displayedMessages[activeIndex], activeIndex, {
            dark: captureDark,
            forCapture: true,
          }),
          captureHost,
        )}

      {/* Sample metadata footer — one compact row. Step is omitted (the
          navigation bar already shows it); Source flexes and truncates. */}
      <div className={`border-t px-3 py-1.5 ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
        {/* One measured run: 20px gaps, hairline dividers between groups,
            11px uppercase labels against 12px values — the metadata reads as
            an instrument strip instead of four loose sentences. */}
        <div className={`flex items-center gap-5 whitespace-nowrap overflow-hidden ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          <div className="flex items-baseline gap-1.5">
            <span className={`text-[11px] uppercase tracking-wide ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Reward:</span>
            <span className={`text-xs font-semibold tnum ${sample.attributes.reward >= 0 ? (isDarkMode ? 'text-teal-400' : 'text-teal-700') : (isDarkMode ? 'text-red-400' : 'text-red-600')}`}>
              {sample.attributes.reward}
            </span>
          </div>
          <div className={`w-px h-3 shrink-0 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-300'}`} />
          <div className="flex items-baseline gap-1.5">
            <span className={`text-[11px] uppercase tracking-wide ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Rollout:</span>
            <span className="text-xs font-medium tnum">{sample.attributes.rollout_n}</span>
          </div>
          <div className={`w-px h-3 shrink-0 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-300'}`} />
          <div className="min-w-0 flex-1 flex items-baseline gap-1.5">
            <span className={`text-[11px] uppercase tracking-wide shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Source:</span>
            <span className="text-xs font-medium truncate min-w-0" title={sample.attributes.data_source}>
              {sample.attributes.data_source}
            </span>
          </div>
          <div className={`w-px h-3 shrink-0 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-300'}`} />
          <div className="flex items-baseline gap-1.5">
            <span className={`text-[11px] uppercase tracking-wide ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Timestamp:</span>
            <span className="text-xs font-medium tnum" title={sample.timestamp}>
              {formatTimestamp(sample.timestamp) ?? sample.timestamp}
            </span>
          </div>
        </div>
      </div>

      {preview && (
        <CapturePreviewModal
          imageUrl={preview.url}
          isDarkMode={isDarkMode}
          onCopy={() => { copyImageToClipboard(preview.blob, preview.caption, preview.filename); }}
          // Paper figures download as a PDF by default — a page sized to the
          // nominal column width, losslessly, ready to \includegraphics. PNG
          // stays one click away; the clipboard is always PNG (item 6 of the
          // figure critic loop).
          //
          // Every one of these reads `preview.opts`, NOT the live settings: the
          // modal must describe the raster it is showing. Changing the style
          // while it is open changes the next capture, not this one.
          downloadLabel={preview.opts.captureStyle === 'paper' ? 'Download PDF' : 'Download'}
          onDownload={preview.opts.captureStyle === 'paper' ? downloadPreviewPdf : downloadPreviewPng}
          onDownloadAlt={preview.opts.captureStyle === 'paper'
            ? { label: 'PNG', onDownload: downloadPreviewPng }
            : undefined}
          onClose={closePreview}
        />
      )}
    </div>
  );
}
