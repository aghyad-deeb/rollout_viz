import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { LeftPanel } from './components/LeftPanel';
import { PresentationPreviewPanel } from './components/RightPanel/PresentationPreviewPanel';
import { RolloutChatPanel } from './components/RolloutChat/RolloutChatPanel';
import { RightPanel } from './components/RightPanel';
import { FileBrowser } from './components/FileBrowser';

const GradingPanel = lazy(() => import('./components/GradingPanel').then(m => ({ default: m.GradingPanel })));
import { useApi } from './hooks/useApi';
import { useMarkedFiles } from './hooks/useMarkedFiles';
import { useDarkMode } from './hooks/useDarkMode';
import { useUrlState } from './hooks/useUrlState';
import { useServerConfig } from './hooks/useServerConfig';
import { LibraryView } from './components/Library';
import { useGrading } from './hooks/useGrading';
import { loadCaptureWidth, saveCaptureWidth, loadCaptureFontSize, saveCaptureFontSize } from './utils/captureImage';
import { buildPageTitle } from './utils/pageTitle';
import { messageToPresentationDraft, type PresentationMessageDraft, type PresentationMessageDrafts } from './utils/presentationDraft';
import {
  COMMENTS_METRIC,
  COMMENT_PROMPT_VERSION,
  TRIAGE_METRIC,
  TRIAGE_VERDICTS,
  buildCommentTombstone,
  buildHumanEntry,
  fileLocationOf,
  latestHumanEntry,
  loadAnnotator,
  mergeAppendOnlyGrades,
  saveAnnotator,
  saveHumanGrade,
} from './utils/humanGrades';
import { TriageBar } from './components/TriageBar';
import type { Sample, SearchCondition, SearchLogic, ExportWidth, FontSize, GradeEntry, ViewMode } from './types';

// Helper to generate unique IDs
const generateId = () => Math.random().toString(36).substring(2, 9);

// Files whose combined sample count exceeds this skip bulk message hydration
// (phase 2) — 12k-rollout eval files stall the tab otherwise. The selected
// sample hydrates individually; a banner offers the full load.
const FULL_HYDRATION_MAX_SAMPLES = 2000;
// …and a byte gate: 767 long agentic rollouts can weigh 400MB+, which the
// sample-count threshold alone misses.
const FULL_HYDRATION_MAX_BYTES = 100 * 1024 * 1024;

function LoginOverlay({ isDarkMode, onLogin }: { isDarkMode: boolean; onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onLogin();
      } else {
        const data = await res.json();
        setError(data.detail || 'Invalid password');
        // The disabled submit drops focus to <body>; put the user back in
        // the field with the wrong value selected, ready to retype.
        passwordRef.current?.select();
      }
    } catch {
      setError('Connection failed');
      passwordRef.current?.select();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`h-screen flex items-center justify-center ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-gray-50'}`}>
      <form onSubmit={handleSubmit} className={`p-8 rounded-xl shadow-lg w-80 ${isDarkMode ? 'bg-gray-900 text-gray-100' : 'bg-white text-gray-900'}`}>
        <h2 className="text-lg font-semibold mb-4">Rollout Visualizer</h2>
        <input
          ref={passwordRef}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={e => { setPassword(e.target.value); if (error) setError(''); }}
          placeholder="Enter password"
          autoFocus
          className={`w-full px-3 py-2 rounded-lg border mb-3 outline-none focus:ring-2 focus:ring-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-700 text-gray-100' : 'bg-white border-gray-300 text-gray-900'}`}
        />
        {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 transition-colors"
        >
          {loading ? 'Checking...' : 'Log in'}
        </button>
      </form>
    </div>
  );
}

function SharedBanner({ isDarkMode, onLogin }: { isDarkMode: boolean; onLogin: () => void }) {
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onLogin();
      } else {
        const data = await res.json();
        setError(data.detail || 'Invalid password');
        passwordRef.current?.select();
      }
    } catch {
      setError('Connection failed');
      passwordRef.current?.select();
    } finally {
      setLoading(false);
    }
  };

  if (!showLogin) {
    return (
      <div className="bg-amber-500 text-amber-950 text-center text-xs font-medium py-1 px-4 flex items-center justify-center gap-3">
        <span>Shared view — read only</span>
        <button
          onClick={() => setShowLogin(true)}
          className="px-2 py-0.5 rounded bg-amber-700 text-amber-100 hover:bg-amber-800 text-xs font-medium transition-colors"
        >
          Log in for full access
        </button>
      </div>
    );
  }

  return (
    <div className={`text-center text-xs font-medium py-2 px-4 flex items-center justify-center gap-2 ${isDarkMode ? 'bg-gray-800 text-gray-200' : 'bg-amber-100 text-amber-900'}`}>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          ref={passwordRef}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={e => { setPassword(e.target.value); if (error) setError(''); }}
          placeholder="Password"
          autoFocus
          className={`px-2 py-1 rounded text-xs w-40 outline-none border ${isDarkMode ? 'bg-gray-700 border-gray-600 text-gray-100' : 'bg-white border-amber-300 text-gray-900'}`}
        />
        <button
          type="submit"
          disabled={loading || !password}
          className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50 transition-colors"
        >
          {loading ? '...' : 'Log in'}
        </button>
        <button
          type="button"
          onClick={() => { setShowLogin(false); setError(''); }}
          className={`px-2 py-1 rounded text-xs ${isDarkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-amber-200 text-amber-800 hover:bg-amber-300'}`}
        >
          Cancel
        </button>
        {error && <span className="text-red-500 text-xs">{error}</span>}
      </form>
    </div>
  );
}

function App() {
  const [authState, setAuthState] = useState<'loading' | 'login' | 'ready' | 'shared' | 'connection_failed'>('loading');
  const [shareToken, setShareToken] = useState<string | null>(() => {
    return sessionStorage.getItem('viz_share_token');
  });
  // `index` is the authoritative disambiguator for share links (matches the
  // `&index=N` param of normal links). Kept in state so the shared-mode
  // samples loader can pick the exact row even when the backend returned the
  // full file — which happens when a logged-in viewer opens a share URL and
  // the session cookie pre-empts the share-token filter in the auth
  // middleware.
  const [shareInfo, setShareInfo] = useState<{ file: string; rollout?: number; step?: number; index?: number } | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [filteredSamples, setFilteredSamples] = useState<Sample[]>([]);
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
  const selectedSampleIdRef = useRef<number | null>(null);
  selectedSampleIdRef.current = selectedSampleId;
  const [experimentName, setExperimentName] = useState<string>('');
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [hydrationSkipped, setHydrationSkipped] = useState(false);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [searchConditions, setSearchConditions] = useState<SearchCondition[]>([
    { id: generateId(), field: 'chat', operator: 'contains', term: '' }
  ]);
  const [searchLogic, setSearchLogic] = useState<SearchLogic>('AND');
  const [currentOccurrenceIndex, setCurrentOccurrenceIndex] = useState(0);
  const [highlightedMessageIndex, setHighlightedMessageIndex] = useState<number | null>(null);
  const [highlightedText, setHighlightedText] = useState<string | null>(null);
  const [selectedGradeMetric, setSelectedGradeMetric] = useState<string | undefined>(undefined);
  const [isGradingPanelOpen, setIsGradingPanelOpen] = useState(false);
  // Once opened, the grading panel stays mounted (hidden) so closing the
  // modal — Escape, backdrop, X — never discards a half-written custom
  // metric prompt. The latch also keeps the lazy chunk unloaded until the
  // first open.
  const [gradingPanelMounted, setGradingPanelMounted] = useState(false);
  // Presentation Mode is owned here so the left panel can swap in a live
  // capture preview; `presentationPreview` holds the rendered PNG's object
  // URL (for display) and the Blob itself (for a reliable copy / download).
  const [isPresentationMode, setIsPresentationMode] = useState(false);
  // "Discuss this rollout" chat — replaces the left panel when open. Mutually
  // exclusive with Presentation Mode.
  const [isRolloutChatOpen, setIsRolloutChatOpen] = useState(false);
  // Comments drawer. Owned here (not in RightPanel) for one reason: the
  // floating grading cluster below is `fixed` and would otherwise sit on top
  // of the drawer's Post button and swallow its clicks.
  const [isCommentsOpen, setIsCommentsOpen] = useState(false);
  // Right-panel view (chat / analysis / evidence / …). Owned here so global
  // keyboard handling can coordinate with the Evidence view's own keys.
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  // Triage Mode: record human verdicts as first-class grade entries.
  const [isTriageMode, setIsTriageMode] = useState(false);
  const [annotator, setAnnotator] = useState<string>(loadAnnotator);
  const [noteDraft, setNoteDraft] = useState('');
  const [triageSaveError, setTriageSaveError] = useState<string | null>(null);
  const [presentationPreview, setPresentationPreview] = useState<{ url: string; blob: Blob } | null>(null);
  // True while the preview image is behind the latest edits (debounce +
  // re-render in flight) — the preview panel dims and holds Copy/Download.
  const [previewPending, setPreviewPending] = useState(false);
  // Stable identity is load-bearing: ChatView's preview effect lists this in
  // its deps, so an inline arrow here would re-trigger the effect after every
  // completed capture (new App render → new identity) and re-capture in an
  // endless loop, pinning "Updating preview…" on forever.
  const handlePresentationPreview = useCallback((url: string | null, blob?: Blob | null) => {
    setPresentationPreview(url && blob ? { url, blob } : null);
  }, []);
  // Capture settings — lifted here so the left-panel preview can host them.
  // Width + font-size are restored from the user's last session; image
  // theme always starts light (a capture defaults to light by design).
  const [imageTheme, setImageTheme] = useState<'light' | 'dark'>('light');
  const [exportWidth, setExportWidth] = useState<ExportWidth>(loadCaptureWidth);
  const [fontSize, setFontSize] = useState<FontSize>(loadCaptureFontSize);
  const [presentationActiveIndex, setPresentationActiveIndex] = useState<number | null>(null);
  const [presentationDrafts, setPresentationDrafts] = useState<PresentationMessageDrafts>({});
  useEffect(() => {
    saveCaptureWidth(exportWidth);
    saveCaptureFontSize(fontSize);
  }, [exportWidth, fontSize]);
  // Press `p` (no modifiers, not while typing) to enter Presentation Mode.
  // The listener is attached only while it's off; once on, `p` is handled
  // per-card (capture the hovered card) instead.
  useEffect(() => {
    if (isPresentationMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'p' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      setIsTriageMode(false);
      setIsPresentationMode(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPresentationMode]);
  // Escape closes the grading modal. Safe even mid-typing: the panel stays
  // mounted (gradingPanelMounted), so the draft survives and reopening
  // restores it. Skipped while the file browser is open so one Escape
  // never closes two layers.
  useEffect(() => {
    if (!isGradingPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isFileBrowserOpen) return;
      setIsGradingPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isGradingPanelOpen, isFileBrowserOpen]);
  const { loading, error, loadWarnings, clearLoadWarnings, loadSamples, loadFilesProgressively, loadMultipleSamplesFull, loadSingleSample, messagesLoaded } = useApi(shareToken);
  const { markedFiles, toggleMark } = useMarkedFiles();
  const { isDarkMode, toggleDarkMode } = useDarkMode();
  const { getUrlState, setUrlState, generateLink } = useUrlState();
  const isSharedMode = authState === 'shared';
  // Cross-app wiring (web_chat base URL) — fetched once after full auth.
  const serverConfig = useServerConfig(authState === 'ready');
  const grading = useGrading(authState === 'ready');
  const initialLoadDone = useRef(false);

  // Check authentication on mount, with retry for backend startup.
  // If URL has ?share=<token>, verify the share token first.
  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams(window.location.search);
    // Only use sessionStorage fallback if the URL doesn't have a ?file= param
    // (which would indicate a regular authenticated deep link, not a share link)
    const shareParam = params.get('share') || (!params.get('file') ? sessionStorage.getItem('viz_share_token') : null);

    // --- Share token flow ---
    if (shareParam) {
      fetch(`/api/share/verify?token=${encodeURIComponent(shareParam)}`)
        .then(res => res.json())
        .then(data => {
          if (cancelled) return;
          if (data.valid) {
            setShareToken(shareParam);
            sessionStorage.setItem('viz_share_token', shareParam);
            setShareInfo({
              file: data.file,
              rollout: data.rollout ?? undefined,
              step: data.step ?? undefined,
              index: data.index ?? undefined,
            });
            setFilePaths([data.file]);
            // Read quote/highlight params before stripping the URL
            const msgParam = params.get('message');
            const hlParam = params.get('highlight');
            if (msgParam) setHighlightedMessageIndex(parseInt(msgParam, 10));
            if (hlParam) setHighlightedText(hlParam);
            initialLoadDone.current = true;
            setAuthState('shared');
          } else {
            sessionStorage.removeItem('viz_share_token');
            setAuthState('login');
          }
        })
        .catch(() => {
          if (!cancelled) setAuthState('connection_failed');
        });
      return () => { cancelled = true; };
    }

    // --- Normal auth check with retry ---
    // Clear any stale share token since we're going through normal auth
    sessionStorage.removeItem('viz_share_token');
    let attempt = 0;
    const maxAttempts = 15;
    const retryDelay = 1000;
    const fetchTimeout = 3000;

    const tryAuthCheck = async () => {
      while (attempt < maxAttempts && !cancelled) {
        attempt++;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), fetchTimeout);
          const res = await fetch('/api/auth/check', { signal: controller.signal });
          clearTimeout(timer);
          const data = await res.json();
          if (!cancelled) {
            setAuthState(data.authenticated ? 'ready' : data.auth_required ? 'login' : 'ready');
          }
          return;
        } catch {
          if (!cancelled && attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, retryDelay));
          }
        }
      }
      if (!cancelled) setAuthState('connection_failed');
    };

    tryAuthCheck();
    return () => { cancelled = true; };
  }, []);

  // Get the primary file path for display and URL (first file or the sample's source file)
  const primaryFilePath = filePaths.length > 0 ? filePaths[0] : '';

  // Initialize from URL on mount (skipped when entering via share link)
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const urlState = getUrlState();
    if (urlState.file) {
      setFilePaths([urlState.file]);
    }
    // No ?file param → leave filePaths empty; the Library renders as the
    // landing view instead of force-loading the demo file.
    if (urlState.message !== undefined) {
      setHighlightedMessageIndex(urlState.message);
    }
    if (urlState.highlight) {
      setHighlightedText(urlState.highlight);
    }
  }, [getUrlState]);

  // Full message hydration for every loaded file, preserving the current
  // selection across the sample-array replacement.
  // NOTE: uses selectedSampleIdRef (not selectedSampleId) to avoid a stale
  // closure — the user may have changed selection since the load started.
  const hydrateAllFiles = useCallback((paths: string[]) => {
    setHydrationSkipped(false);
    return loadMultipleSamplesFull(paths).then((fullData) => {
        if (!fullData) return;
        setSamples(prev => {
          const currentId = selectedSampleIdRef.current;
          const currentlySelected = currentId !== null ? prev.find(s => s.id === currentId) : null;
          const newSamples = fullData.samples;
          // Re-find the selected sample in the new dataset by index within its file
          // (rollout_n + step + source_file is NOT unique — multiple samples can share these)
          if (currentlySelected) {
            const sourceFile = currentlySelected.attributes.source_file || '';
            const oldFileSamples = prev.filter(s => (s.attributes.source_file || '') === sourceFile);
            const indexInFile = oldFileSamples.findIndex(s => s.id === currentlySelected.id);
            const newFileSamples = newSamples.filter(s => (s.attributes.source_file || '') === sourceFile);
            const match = indexInFile >= 0 ? newFileSamples[indexInFile] : undefined;
            if (match) {
              setSelectedSampleId(match.id);
            }
          }
          return newSamples;
        });
      });
  }, [loadMultipleSamplesFull]);

  // Load samples when file paths change (only after authenticated or in shared mode)
  // In shared mode: single GET request for the authorized file (filtered server-side).
  // In full mode: progressive per-file loading with background message hydration.
  useEffect(() => {
    if (filePaths.length === 0 || (authState !== 'ready' && authState !== 'shared')) return;

    // Clear samples before starting new load
    setSamples([]);
    setSelectedSampleId(null);

    // --- Shared mode: simple single-file load ---
    if (isSharedMode) {
      loadSamples(filePaths[0]).then(data => {
        if (!data) return;
        setExperimentName(data.experiment_name || '');

        // Pick the exact shared sample by its file-relative index when the
        // token carries one. This handles two cases uniformly:
        //  1) Backend filtered on share token → data.samples is already just
        //     that one row; `find` returns it.
        //  2) Viewer was simultaneously logged in, so session cookie
        //     pre-empted the share-token filter in auth middleware and
        //     data.samples contains the whole file. Without this lookup,
        //     the UI would silently land on sample 0 instead of the shared
        //     target.
        const shareIdx = shareInfo?.index;
        let chosen: Sample | null = null;
        if (shareIdx !== undefined) {
          chosen = data.samples.find(s => s.id === shareIdx) ?? null;
        }
        if (chosen) {
          // Hide siblings — a shared link should only expose the one row.
          setSamples([chosen]);
          setSelectedSampleId(chosen.id);
        } else {
          // Legacy token (no index) or index out of range — fall back to the
          // server-filtered list and pick its first entry.
          setSamples(data.samples);
          if (data.samples.length > 0) {
            setSelectedSampleId(data.samples[0].id);
          }
        }
      });
      return;
    }

    // --- Full mode: progressive loading ---
    const urlState = getUrlState();
    let firstFileHandled = false;

    setHydrationSkipped(false);
    let loadedCount = 0;
    let loadedBytes = 0;

    // Phase 1: progressive per-file metadata loading
    loadFilesProgressively(filePaths, (fileSamples, _loadedPath, rawBytes) => {
      loadedCount += fileSamples.length;
      loadedBytes += rawBytes;
      // Called as each file completes — append samples with sequential IDs
      setSamples(prev => {
        const nextId = prev.length;
        const newSamples = fileSamples.map((s: Sample, i: number) => ({
          ...s,
          id: nextId + i,
        }));
        return [...prev, ...newSamples];
      });

      // Auto-select first sample or URL-targeted sample on first file
      if (!firstFileHandled) {
        firstFileHandled = true;
        if (urlState.index !== undefined) {
          // Use exact index within file for disambiguation
          const targetSample = fileSamples[urlState.index];
          if (targetSample) {
            setSamples(prev => {
              const found = prev[urlState.index!];
              if (found) setSelectedSampleId(found.id);
              else if (prev.length > 0) setSelectedSampleId(prev[0].id);
              return prev;
            });
          } else {
            setSelectedSampleId(0);
          }
        } else if (urlState.rollout !== undefined) {
          const targetSample = fileSamples.find(s =>
            Number(s.attributes.rollout_n) === urlState.rollout &&
            (urlState.step === undefined || Number(s.attributes.step) === urlState.step)
          );
          if (targetSample) {
            // Will get ID 0+ based on current state, use functional lookup
            setSamples(prev => {
              const found = prev.find(s =>
                Number(s.attributes.rollout_n) === urlState.rollout &&
                (urlState.step === undefined || Number(s.attributes.step) === urlState.step)
              );
              if (found) setSelectedSampleId(found.id);
              else if (prev.length > 0) setSelectedSampleId(prev[0].id);
              return prev;
            });
          } else {
            setSelectedSampleId(0); // First sample of first file
          }
        } else {
          setSelectedSampleId(0);
        }
      }
    }).then((result) => {
      if (!result) return;
      setExperimentName(result.experimentName);

      // If URL-targeted sample wasn't in first file, find it now
      if (urlState.index !== undefined || urlState.rollout !== undefined) {
        setSamples(prev => {
          let found;
          if (urlState.index !== undefined) {
            // For index-based lookup, find samples from the URL file
            const fileSamples = prev.filter(s => (s.attributes.source_file || '') === (urlState.file || ''));
            found = fileSamples[urlState.index];
          }
          if (!found && urlState.rollout !== undefined) {
            found = prev.find(s =>
              Number(s.attributes.rollout_n) === urlState.rollout &&
              (urlState.step === undefined || Number(s.attributes.step) === urlState.step)
            );
          }
          if (found) setSelectedSampleId(found.id);
          return prev;
        });
      }

      // Phase 2: full load in background → hydrate messages. Skipped above
      // the sample threshold — selected samples hydrate individually and the
      // banner in LeftPanel offers the full load.
      if (loadedCount > FULL_HYDRATION_MAX_SAMPLES || loadedBytes > FULL_HYDRATION_MAX_BYTES) {
        setHydrationSkipped(true);
        return;
      }
      hydrateAllFiles(filePaths);
    });
  }, [filePaths, authState, isSharedMode, shareInfo, loadSamples, loadFilesProgressively, hydrateAllFiles, getUrlState]);


  // On-demand message loading: when user selects a sample that has empty messages
  // and background full load hasn't completed yet, fetch that single sample's messages
  useEffect(() => {
    if (selectedSampleId === null || messagesLoaded) return;

    const sample = samples.find(s => s.id === selectedSampleId);
    if (!sample || sample.messages.length > 0) return;

    // Determine which file this sample came from
    const sourceFile = sample.attributes.source_file || filePaths[0];

    // Find the sample's original index within its source file
    // The batch endpoint assigns sequential IDs across all files, but the
    // single-sample endpoint needs the index within that specific file
    const samplesFromSameFile = samples.filter(s => (s.attributes.source_file || filePaths[0]) === sourceFile);
    const indexInFile = samplesFromSameFile.indexOf(sample);
    if (indexInFile < 0) return;

    const targetId = selectedSampleId; // Capture current value for this request
    loadSingleSample(indexInFile, sourceFile).then((singleSample) => {
      if (!singleSample) return;
      setSamples(prev => prev.map(s =>
        s.id === targetId
          // Merge, don't replace: a comment/tombstone appended while this
          // hydration request was in flight must survive the stale response.
          ? { ...s, messages: singleSample.messages, grades: mergeAppendOnlyGrades(s.grades, singleSample.grades) }
          : s
      ));
    });
  }, [selectedSampleId, messagesLoaded, samples, filePaths, loadSingleSample]);

  // True while the rollout-chat panel holds a conversation worth protecting.
  // A ref (not state) — it changes on every streamed token batch and nothing
  // needs to re-render on it; the confirm gates below just read it.
  const chatDirtyRef = useRef(false);

  // Select a sample and clear highlights (used when user clicks a sample)
  const handleSelectSample = useCallback((id: number) => {
    // Switching samples remounts the rollout chat (keyed by sample id) and
    // silently destroys the conversation — confirm first when one exists.
    if (
      isRolloutChatOpen &&
      chatDirtyRef.current &&
      id !== selectedSampleIdRef.current &&
      !window.confirm('Switching rollouts clears the current discussion. Continue?')
    ) return;
    setSelectedSampleId(id);
    // Clear any highlights and grade selection when user manually changes sample
    setHighlightedMessageIndex(null);
    setHighlightedText(null);
    setSelectedGradeMetric(undefined);
  }, [isRolloutChatOpen]);

  // Update URL whenever the selected sample changes (skip in shared mode — keep ?share= URL)
  useEffect(() => {
    if (isSharedMode) return;
    if (filePaths.length === 0 || samples.length === 0 || selectedSampleId === null) return;

    const selectedSample = samples.find(s => s.id === selectedSampleId);
    if (!selectedSample) return;
    const fileForUrl = selectedSample.attributes.source_file || primaryFilePath;
    const sourceFile = selectedSample.attributes.source_file || '';
    const samplesFromSameFile = samples.filter(s => (s.attributes.source_file || '') === sourceFile);
    const indexInFile = samplesFromSameFile.findIndex(s => s.id === selectedSample.id);
    setUrlState({
      file: fileForUrl,
      rollout: selectedSample.attributes.rollout_n,
      step: selectedSample.attributes.step,
      index: indexInFile >= 0 ? indexInFile : undefined,
      message: highlightedMessageIndex ?? undefined,
      highlight: highlightedText ?? undefined,
    });
  }, [isSharedMode, filePaths, primaryFilePath, selectedSampleId, samples, setUrlState, highlightedMessageIndex, highlightedText]);

  const selectedSample = samples.find(s => s.id === selectedSampleId) || null;

  // Keep the browser tab title in sync with what's loaded, so multiple viz
  // tabs (a common flow when sharing links) are distinguishable.
  useEffect(() => {
    const rolloutN = selectedSample ? Number(selectedSample.attributes.rollout_n) : NaN;
    document.title = buildPageTitle({
      experimentName,
      sourceFile: selectedSample?.attributes.source_file || primaryFilePath || undefined,
      rolloutN: Number.isFinite(rolloutN) ? rolloutN : undefined,
      isSharedMode,
    });
  }, [experimentName, selectedSample, primaryFilePath, isSharedMode]);

  useEffect(() => {
    setPresentationActiveIndex(null);
    setPresentationDrafts({});
    setPresentationPreview(null);
  }, [selectedSample?.id]);

  const activePresentationMessage = presentationActiveIndex !== null
    ? selectedSample?.messages[presentationActiveIndex] ?? null
    : null;

  const activePresentationDraft = useMemo(() => {
    if (presentationActiveIndex === null || !activePresentationMessage) return null;
    return presentationDrafts[presentationActiveIndex] ?? messageToPresentationDraft(activePresentationMessage);
  }, [activePresentationMessage, presentationActiveIndex, presentationDrafts]);

  const activePresentationDraftDirty = useMemo(() => {
    if (presentationActiveIndex === null || !activePresentationMessage || !activePresentationDraft) return false;
    return JSON.stringify(activePresentationDraft) !== JSON.stringify(messageToPresentationDraft(activePresentationMessage));
  }, [activePresentationDraft, activePresentationMessage, presentationActiveIndex]);

  const updateActivePresentationDraft = useCallback((draft: PresentationMessageDraft) => {
    if (presentationActiveIndex === null) return;
    setPresentationDrafts((prev) => ({ ...prev, [presentationActiveIndex]: draft }));
  }, [presentationActiveIndex]);

  const resetActivePresentationDraft = useCallback(() => {
    if (presentationActiveIndex === null) return;
    setPresentationDrafts((prev) => {
      const next = { ...prev };
      delete next[presentationActiveIndex];
      return next;
    });
  }, [presentationActiveIndex]);

  const clearPresentationDrafts = useCallback(() => {
    setPresentationDrafts({});
  }, []);

  // Get the actual file path for links (use sample's source file or primary file)
  const getFilePathForSample = (sample: Sample | null): string => {
    return sample?.attributes.source_file || primaryFilePath;
  };

  const gradingJobs = useMemo(() => {
    const samplesByFile = new Map<string, Sample[]>();
    for (const sample of samples) {
      const sourceFile = sample.attributes.source_file || primaryFilePath;
      const existing = samplesByFile.get(sourceFile);
      if (existing) {
        existing.push(sample);
      } else {
        samplesByFile.set(sourceFile, [sample]);
      }
    }

    const idsByFile = new Map<string, number[]>();
    for (const sample of filteredSamples) {
      const sourceFile = sample.attributes.source_file || primaryFilePath;
      const fileSamples = samplesByFile.get(sourceFile) || [];
      const fileLocalId = fileSamples.findIndex(s => s.id === sample.id);
      if (fileLocalId < 0) continue;

      const existing = idsByFile.get(sourceFile);
      if (existing) {
        existing.push(fileLocalId);
      } else {
        idsByFile.set(sourceFile, [fileLocalId]);
      }
    }

    return Array.from(idsByFile, ([filePath, sampleIds]) => ({ filePath, sampleIds }));
  }, [filteredSamples, samples, primaryFilePath]);

  // File-relative index of the selected sample — the authoritative
  // disambiguator for share tokens. Two samples in the same file can share
  // (rollout_n, step), so filtering by those alone picks the wrong one.
  const selectedIndexInFile = useMemo<number | undefined>(() => {
    if (!selectedSample) return undefined;
    const sourceFile = selectedSample.attributes.source_file || '';
    const samplesFromSameFile = samples.filter(s => (s.attributes.source_file || '') === sourceFile);
    const idx = samplesFromSameFile.findIndex(s => s.id === selectedSample.id);
    return idx >= 0 ? idx : undefined;
  }, [selectedSample, samples]);

  // Wrap generateLink to automatically include the selected sample's index_in_file
  const generateLinkWithIndex = useCallback((options: {
    file: string;
    rollout?: number;
    step?: number;
    message?: number;
    highlight?: string;
  }): string => {
    return generateLink({ ...options, index: selectedIndexInFile });
  }, [selectedIndexInFile, generateLink]);

  const handleNavigate = useCallback((direction: 'first' | 'prev' | 'next' | 'last') => {
    // Navigate through filtered samples if filtering is active, otherwise all samples
    const navSamples = filteredSamples.length > 0 ? filteredSamples : samples;
    if (navSamples.length === 0) return;

    const currentIndex = navSamples.findIndex(s => s.id === selectedSampleId);
    let newIndex: number;

    switch (direction) {
      case 'first':
        newIndex = 0;
        break;
      case 'prev':
        newIndex = Math.max(0, currentIndex - 1);
        break;
      case 'next':
        newIndex = Math.min(navSamples.length - 1, currentIndex + 1);
        break;
      case 'last':
        newIndex = navSamples.length - 1;
        break;
    }

    handleSelectSample(navSamples[newIndex].id);
  }, [filteredSamples, samples, selectedSampleId, handleSelectSample]);

  // J / K step to the next / previous sample — the core triage loop should
  // not require clicking 28px arrow buttons. Disabled while typing, while a
  // modal is open, in Presentation Mode / rollout chat (where a stray
  // sample change would discard capture drafts or the chat), and in the
  // Evidence view (which owns J/K for its own card cursor).
  useEffect(() => {
    if (isPresentationMode || isRolloutChatOpen || isGradingPanelOpen || isFileBrowserOpen || viewMode === 'evidence') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      handleNavigate(k === 'j' ? 'next' : 'prev');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPresentationMode, isRolloutChatOpen, isGradingPanelOpen, isFileBrowserOpen, viewMode, handleNavigate]);

  // ── Triage Mode: human verdicts as first-class grade entries ─────────────

  const handleAnnotatorChange = useCallback((name: string) => {
    setAnnotator(name);
    saveAnnotator(name);
  }, []);

  // Reviewed counts over the filtered scope (latest human entry wins).
  const triageStats = useMemo(() => {
    let reviewed = 0;
    const counts: Record<string, number> = {};
    for (const v of TRIAGE_VERDICTS) counts[v] = 0;
    for (const s of filteredSamples) {
      const hv = latestHumanEntry(s.grades?.[TRIAGE_METRIC]);
      if (hv) {
        reviewed++;
        const g = String(hv.grade);
        counts[g] = (counts[g] ?? 0) + 1;
      }
    }
    return { reviewed, counts };
  }, [filteredSamples]);

  // Persist one human grade entry and mirror it into local state so grade
  // columns / filters / Analysis update without a reload.
  const applyHumanGrade = useCallback(async (sampleId: number, metric: string, entry: GradeEntry): Promise<boolean> => {
    const sample = samples.find(s => s.id === sampleId);
    if (!sample) return false;
    const loc = fileLocationOf(sample, samples, primaryFilePath);
    if (!loc) return false;
    const ok = await saveHumanGrade(loc.filePath, loc.indexInFile, metric, entry);
    if (ok) {
      setSamples(prev => prev.map(s => s.id === sampleId
        ? { ...s, grades: { ...(s.grades ?? {}), [metric]: [...(s.grades?.[metric] ?? []), entry] } }
        : s));
    }
    return ok;
  }, [samples, primaryFilePath]);

  // A comment is a freeform human entry on the reserved `comments` metric —
  // same append-only rails as the verdicts, so it lands in viz/<file>.jsonl
  // and mirrors into local state without a reload. Returns false when the
  // write failed, so the panel can keep the user's draft.
  const handleAddComment = useCallback(async (sampleId: number, text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body) return false;
    const entry = buildHumanEntry({
      grade: body,
      gradeType: 'freeform',
      annotator,
      promptVersion: COMMENT_PROMPT_VERSION,
    });
    return applyHumanGrade(sampleId, COMMENTS_METRIC, entry);
  }, [annotator, applyHumanGrade]);

  // Deleting a comment is a SOFT delete: the append-only log can't drop a row,
  // so we append a signed tombstone naming the retracted entry. Every reader
  // goes through visibleComments(), so the comment disappears everywhere while
  // the raw JSONL keeps both it and the deletion record.
  const handleDeleteComment = useCallback(async (sampleId: number, target: GradeEntry): Promise<boolean> => {
    if (!annotator.trim()) return false;
    const tombstone = buildCommentTombstone(target, annotator.trim());
    return applyHumanGrade(sampleId, COMMENTS_METRIC, tombstone);
  }, [annotator, applyHumanGrade]);

  const handleJumpToUnreviewed = useCallback(() => {
    const next = filteredSamples.find(s => !latestHumanEntry(s.grades?.[TRIAGE_METRIC]));
    if (next) handleSelectSample(next.id);
  }, [filteredSamples, handleSelectSample]);

  const handleTriageVerdict = useCallback(async (verdict: string) => {
    const current = selectedSampleIdRef.current;
    if (current === null || !annotator) return;
    const entry = buildHumanEntry({
      grade: verdict,
      gradeType: 'categorical',
      annotator,
      note: noteDraft.trim() || undefined,
    });
    const ok = await applyHumanGrade(current, TRIAGE_METRIC, entry);
    if (!ok) {
      setTriageSaveError('Save failed — verdict not recorded');
      return;
    }
    setTriageSaveError(null);
    setNoteDraft('');
    // Advance to the next unreviewed sample after this one, wrapping around.
    // filteredSamples still holds pre-save grades; the just-verdicted sample
    // is excluded by id so it can't be re-visited.
    const idx = filteredSamples.findIndex(s => s.id === current);
    for (let step = 1; step <= filteredSamples.length; step++) {
      const cand = filteredSamples[(Math.max(0, idx) + step) % filteredSamples.length];
      if (cand.id === current) break;
      if (!latestHumanEntry(cand.grades?.[TRIAGE_METRIC])) {
        handleSelectSample(cand.id);
        return;
      }
    }
  }, [annotator, noteDraft, applyHumanGrade, filteredSamples, handleSelectSample]);

  // Number keys 1-N record verdicts while triaging (guarded like J/K; also
  // inactive in the Evidence view, which records audits with its own keys).
  useEffect(() => {
    if (!isTriageMode || isPresentationMode || isRolloutChatOpen || isGradingPanelOpen || isFileBrowserOpen || viewMode === 'evidence') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= TRIAGE_VERDICTS.length) {
        e.preventDefault();
        handleTriageVerdict(TRIAGE_VERDICTS[n - 1]);
      } else if (e.key.toLowerCase() === 'u') {
        e.preventDefault();
        handleJumpToUnreviewed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTriageMode, isPresentationMode, isRolloutChatOpen, isGradingPanelOpen, isFileBrowserOpen, viewMode, handleTriageVerdict, handleJumpToUnreviewed]);

  const handleToggleTriageMode = useCallback(() => {
    setIsTriageMode(prev => {
      if (!prev) {
        // Entering: presentation mode and the rollout chat both conflict
        // with verdict hotkeys and auto-advance.
        if (isRolloutChatOpen && chatDirtyRef.current && !window.confirm('Entering Triage Mode closes the discussion. Continue?')) return prev;
        chatDirtyRef.current = false;
        setIsPresentationMode(false);
        setIsRolloutChatOpen(false);
      }
      return !prev;
    });
    setTriageSaveError(null);
  }, [isRolloutChatOpen]);

  // ── Evidence view plumbing ────────────────────────────────────────────────

  // Jump from an evidence card into the chat at the quoted span, reusing the
  // deep-link highlight mechanics.
  const handleOpenQuote = useCallback((sampleId: number, messageIndex: number | null, highlightText: string | null) => {
    handleSelectSample(sampleId);
    setViewMode('chat');
    if (messageIndex !== null) setHighlightedMessageIndex(messageIndex);
    if (highlightText) setHighlightedText(highlightText);
  }, [handleSelectSample]);

  // Record a human confirm/dispute of a judge's bool grade: appended to the
  // SAME metric list, so the human call becomes the latest (displayed) grade
  // while the judge's entry stays in the run history.
  const handleAudit = useCallback((sampleId: number, metric: string, action: 'confirm' | 'dispute', judgeEntry: GradeEntry) => {
    if (!annotator) return;
    const grade = judgeEntry.grade_type === 'bool'
      ? (action === 'confirm' ? Boolean(judgeEntry.grade) : !judgeEntry.grade)
      : judgeEntry.grade;
    const entry = buildHumanEntry({
      grade,
      gradeType: judgeEntry.grade_type,
      annotator,
      note: `${action === 'confirm' ? 'confirmed' : 'disputed'} ${judgeEntry.model}`,
      promptVersion: 'audit-v1',
    });
    applyHumanGrade(sampleId, metric, entry);
  }, [annotator, applyHumanGrade]);

  // Latest human verdict on the selected sample (drives the TriageBar).
  const selectedTriageEntry = selectedSample
    ? latestHumanEntry(selectedSample.grades?.[TRIAGE_METRIC])
    : undefined;

  // Reload samples after grading to pick up the viz/ version with grades
  const handleGradingComplete = useCallback(() => {
    if (filePaths.length === 0) return;
    // Full reload (not metadata-only) since user expects grades to appear
    loadMultipleSamplesFull(filePaths).then((data) => {
      if (data) {
        setSamples(data.samples);
      }
    });
  }, [filePaths, loadMultipleSamplesFull]);

  // Reattach to an in-progress server-side grading job after a page reload, so
  // the progress bar resumes advancing. Completed grades already load from viz/.
  const reattachedRef = useRef(false);
  useEffect(() => {
    if (authState !== 'ready' || filePaths.length === 0) return;
    if (reattachedRef.current || grading.progress.isRunning) return;
    reattachedRef.current = true;
    grading.listGradeJobs(filePaths).then(jobs => {
      const active = jobs.find(j => j.status === 'running');
      if (active) grading.attachToJob(active.job_id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, filePaths, grading.progress.isRunning]);

  // When a grading job finishes (including one reattached to with the panel
  // closed), refresh samples so the final grades appear.
  const lastGradeStatusRef = useRef(grading.progress.status);
  useEffect(() => {
    if (grading.progress.status === 'complete' && lastGradeStatusRef.current !== 'complete') {
      handleGradingComplete();
    }
    lastGradeStatusRef.current = grading.progress.status;
  }, [grading.progress.status, handleGradingComplete]);

  if (authState === 'loading') {
    return (
      <div className={`h-screen flex items-center justify-center ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
        <div className="text-center">
          <span className={`material-symbols-outlined animate-spin ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} style={{ fontSize: 32 }}>progress_activity</span>
          <p className={`mt-3 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Connecting to server...</p>
        </div>
      </div>
    );
  }
  if (authState === 'connection_failed') {
    return (
      <div className={`h-screen flex items-center justify-center ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-gray-50'}`}>
        <div className={`p-8 rounded-xl shadow-lg w-80 text-center ${isDarkMode ? 'bg-gray-900 text-gray-100' : 'bg-white text-gray-900'}`}>
          <span className={`material-symbols-outlined ${isDarkMode ? 'text-red-400' : 'text-red-500'}`} style={{ fontSize: 40 }}>cloud_off</span>
          <h2 className="text-lg font-semibold mt-3 mb-2">Connection Failed</h2>
          <p className={`text-sm mb-4 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Could not connect to the server. It may still be starting up.
          </p>
          <button
            onClick={() => { setAuthState('loading'); window.location.reload(); }}
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (authState === 'login') {
    return <LoginOverlay isDarkMode={isDarkMode} onLogin={() => setAuthState('ready')} />;
  }

  return (
    <div className={`h-screen flex flex-col ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
      {/* Shared mode banner with login upgrade */}
      {isSharedMode && (
        <SharedBanner isDarkMode={isDarkMode} onLogin={() => {
          sessionStorage.removeItem('viz_share_token');
          setShareToken(null);
          setAuthState('ready');
        }} />
      )}

      {/* Triage bar — record human verdicts with 1-4 while reading */}
      {!isSharedMode && isTriageMode && (
        <TriageBar
          isDarkMode={isDarkMode}
          annotator={annotator}
          onAnnotatorChange={handleAnnotatorChange}
          verdicts={TRIAGE_VERDICTS}
          currentVerdict={selectedTriageEntry ? String(selectedTriageEntry.grade) : null}
          currentNote={selectedTriageEntry?.explanation ?? ''}
          noteDraft={noteDraft}
          onNoteDraftChange={setNoteDraft}
          reviewedCount={triageStats.reviewed}
          totalCount={filteredSamples.length}
          verdictCounts={triageStats.counts}
          hasSelection={selectedSample !== null}
          onVerdict={handleTriageVerdict}
          onJumpToUnreviewed={handleJumpToUnreviewed}
          saveError={triageSaveError}
          onClose={handleToggleTriageMode}
        />
      )}

      {authState === 'ready' && filePaths.length === 0 ? (
        <LibraryView
          isDarkMode={isDarkMode}
          onOpenFile={setFilePaths}
          onOpenFileBrowser={() => setIsFileBrowserOpen(true)}
        />
      ) : (
      <PanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <Panel id="left" defaultSize="35%" minSize="10%" maxSize="90%">
          {isPresentationMode ? (
            <PresentationPreviewPanel
              imageUrl={presentationPreview?.url ?? null}
              imageBlob={presentationPreview?.blob ?? null}
              isPending={previewPending}
              isDarkMode={isDarkMode}
              imageTheme={imageTheme}
              exportWidth={exportWidth}
              fontSize={fontSize}
              onImageThemeChange={setImageTheme}
              onExportWidthChange={setExportWidth}
              onFontSizeChange={setFontSize}
              activeMessageIndex={presentationActiveIndex}
              messageLabels={selectedSample?.messages.map((m, i) =>
                presentationDrafts[i]?.displayLabel || presentationDrafts[i]?.role || m.role
              ) ?? []}
              exportBaseName={selectedSample && presentationActiveIndex !== null
                ? `rollout-${selectedSample.attributes.rollout_n}-step${selectedSample.attributes.step}-msg${presentationActiveIndex + 1}`
                : undefined}
              activeDraft={activePresentationDraft}
              activeDraftDirty={activePresentationDraftDirty}
              draftCount={Object.keys(presentationDrafts).length}
              onActiveMessageIndexChange={setPresentationActiveIndex}
              onActiveDraftChange={updateActivePresentationDraft}
              onResetActiveDraft={resetActivePresentationDraft}
              onClearDrafts={clearPresentationDrafts}
            />
          ) : isRolloutChatOpen ? (
            <RolloutChatPanel
              key={selectedSample?.id ?? 'no-sample'}
              sample={selectedSample}
              isDarkMode={isDarkMode}
              onDirtyChange={(dirty) => { chatDirtyRef.current = dirty; }}
              onClose={() => {
                if (chatDirtyRef.current && !window.confirm('Close the discussion? The conversation will be lost.')) return;
                chatDirtyRef.current = false;
                setIsRolloutChatOpen(false);
              }}
            />
          ) : (
          <LeftPanel
            samples={samples}
            selectedSampleId={selectedSampleId}
            onSelectSample={handleSelectSample}
            experimentName={experimentName}
            filePaths={filePaths}
            onFilePathsChange={isSharedMode ? () => {} : setFilePaths}
            onOpenFileBrowser={isSharedMode ? () => {} : () => setIsFileBrowserOpen(true)}
            searchConditions={searchConditions}
            onSearchConditionsChange={setSearchConditions}
            searchLogic={searchLogic}
            onSearchLogicChange={setSearchLogic}
            loading={loading}
            error={error}
            loadWarnings={loadWarnings}
            onDismissLoadWarnings={clearLoadWarnings}
            isDarkMode={isDarkMode}
            onToggleDarkMode={toggleDarkMode}
            onFilteredSamplesChange={setFilteredSamples}
            onCurrentOccurrenceIndexChange={setCurrentOccurrenceIndex}
            messagesLoaded={messagesLoaded}
            isSharedMode={isSharedMode}
            hydrationSkipped={hydrationSkipped}
            onLoadAllMessages={() => hydrateAllFiles(filePaths)}
          />
          )}
        </Panel>
        
        <PanelResizeHandle className={`w-1 ${isDarkMode ? 'bg-gray-700 hover:bg-gray-500' : 'bg-gray-200 hover:bg-gray-400'} transition-colors cursor-col-resize`} />
        
        <Panel id="right" defaultSize="65%" minSize="10%">
          <RightPanel
            sample={selectedSample}
            filteredSamples={filteredSamples}
            experimentName={experimentName}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onNavigate={handleNavigate}
            searchConditions={searchConditions}
            currentOccurrenceIndex={currentOccurrenceIndex}
            isDarkMode={isDarkMode}
            filePath={getFilePathForSample(selectedSample)}
            generateLink={generateLinkWithIndex}
            webChatBaseUrl={serverConfig?.web_chat_base_url ?? null}
            highlightedMessageIndex={highlightedMessageIndex}
            highlightedText={highlightedText}
            onClearHighlight={() => {
              setHighlightedMessageIndex(null);
              setHighlightedText(null);
            }}
            selectedGradeMetric={selectedGradeMetric}
            onSelectGradeMetric={setSelectedGradeMetric}
            isSharedMode={isSharedMode}
            shareToken={shareToken}
            selectedIndexInFile={selectedIndexInFile}
            isPresentationMode={isPresentationMode}
            onTogglePresentationMode={() => {
              // Entering Presentation Mode closes the rollout chat — confirm
              // before silently discarding a live discussion.
              if (isRolloutChatOpen && chatDirtyRef.current && !window.confirm('Entering Presentation Mode closes the discussion. Continue?')) return;
              if (isRolloutChatOpen) chatDirtyRef.current = false;
              setIsRolloutChatOpen(false);
              setIsTriageMode(false);
              setIsPresentationMode((v) => !v);
            }}
            onExitPresentationMode={() => setIsPresentationMode(false)}
            isTriageMode={isTriageMode}
            onToggleTriageMode={handleToggleTriageMode}
            annotator={annotator}
            onAnnotatorChange={handleAnnotatorChange}
            onOpenQuote={handleOpenQuote}
            onAudit={handleAudit}
            onAddComment={isSharedMode ? undefined : handleAddComment}
            onDeleteComment={isSharedMode ? undefined : handleDeleteComment}
            isCommentsOpen={isCommentsOpen}
            onToggleComments={() => setIsCommentsOpen(v => !v)}
            isRolloutChatOpen={isRolloutChatOpen}
            onToggleRolloutChat={() => {
              if (isRolloutChatOpen && chatDirtyRef.current && !window.confirm('Close the discussion? The conversation will be lost.')) return;
              if (isRolloutChatOpen) chatDirtyRef.current = false;
              setIsPresentationMode(false);
              setIsTriageMode(false);
              setIsRolloutChatOpen((v) => !v);
            }}
            onPresentationPreview={handlePresentationPreview}
            onPreviewPending={setPreviewPending}
            imageTheme={imageTheme}
            exportWidth={exportWidth}
            fontSize={fontSize}
            presentationDrafts={presentationDrafts}
            presentationActiveIndex={presentationActiveIndex}
            onPresentationActiveIndexChange={setPresentationActiveIndex}
          />
        </Panel>
      </PanelGroup>
      )}

      {/* File Browser Modal — hidden in shared mode */}
      {!isSharedMode && (
        <FileBrowser
          isOpen={isFileBrowserOpen}
          onClose={() => setIsFileBrowserOpen(false)}
          onSelectFiles={(paths) => {
            setFilePaths(paths);
            setSelectedSampleId(null);
          }}
          markedFiles={markedFiles}
          onToggleMark={toggleMark}
          isDarkMode={isDarkMode}
        />
      )}

      {/* Grading Panel Modal — hidden in shared mode. Stays mounted once
          opened (visibility toggled with CSS) so drafted metric config
          survives Escape / backdrop / X dismissal. */}
      {!isSharedMode && gradingPanelMounted && (
        <div
          className={`fixed inset-0 z-50 items-center justify-center bg-black/50 ${isGradingPanelOpen ? 'flex' : 'hidden'}`}
          onClick={() => setIsGradingPanelOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="LLM grading"
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-xl mx-4 max-h-[90vh] overflow-y-auto custom-scrollbar rounded-xl shadow-2xl ${isDarkMode ? 'bg-gray-900' : 'bg-white'}`}
          >
            <button
              onClick={() => setIsGradingPanelOpen(false)}
              aria-label="Close grading panel"
              title="Close (Esc)"
              className={`absolute top-3 right-3 p-1 rounded-lg ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
            >
              <span className="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
            <div className="p-4">
              <Suspense fallback={
                <div className={`flex items-center justify-center p-8 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  <span className="material-symbols-outlined animate-spin" style={{ fontSize: 32 }}>progress_activity</span>
                </div>
              }>
                <GradingPanel
                  gradingJobs={gradingJobs}
                  isDarkMode={isDarkMode}
                  onGradingComplete={handleGradingComplete}
                  grading={grading}
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {/* Floating Grade Button — hidden in shared mode.
          While the comments drawer is open the cluster slides left of it
          (24rem drawer + the usual 1.5rem gutter): it used to sit on top of
          the drawer's Post button and eat its clicks. It shifts rather than
          hides because it also carries Cancel grading, which must stay
          reachable for the whole length of a run. Below sm the drawer is a
          full-width overlay with no free gutter, so the cluster hides there
          — nothing behind the overlay is actionable anyway. */}
      {!isSharedMode && samples.length > 0 && (
        <div
          className={`fixed bottom-6 right-6 z-40 items-center gap-2 ${
            isCommentsOpen ? 'hidden sm:flex sm:right-[25.5rem]' : 'flex'
          }`}
        >
          {grading.progress.isRunning && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                grading.cancelGrading();
              }}
              className="rounded-full shadow-lg bg-red-500 hover:bg-red-600 text-white p-3 transition-all"
              title="Cancel grading"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
            </button>
          )}
          <button
            onClick={() => { setGradingPanelMounted(true); setIsGradingPanelOpen(true); }}
            className={`rounded-full shadow-lg transition-all flex items-center gap-2
              ${grading.progress.isRunning 
                ? 'bg-blue-600 text-white px-4 py-3'
                : 'bg-blue-600 hover:bg-blue-700 text-white p-4'
              }`}
            title={grading.progress.isRunning ? grading.progress.statusMessage : "Grade samples with LLM"}
            aria-label="Grade samples with LLM"
          >
            {grading.progress.isRunning ? (
              <>
                <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="text-sm font-medium whitespace-nowrap">
                  {grading.progress.status === 'grading' 
                    ? `${grading.progress.completed}/${grading.progress.total}`
                    : grading.progress.status === 'saving' 
                      ? 'Saving...'
                      : 'Starting...'}
                </span>
              </>
            ) : (
              <span className="material-symbols-outlined" style={{ fontSize: 24 }}>psychology</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
