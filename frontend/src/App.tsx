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
import { useGrading } from './hooks/useGrading';
import { loadCaptureWidth, saveCaptureWidth, loadCaptureFontSize, saveCaptureFontSize } from './utils/captureImage';
import type { Sample, SearchCondition, SearchLogic, ExportWidth, FontSize } from './types';

// Helper to generate unique IDs
const generateId = () => Math.random().toString(36).substring(2, 9);

function LoginOverlay({ isDarkMode, onLogin }: { isDarkMode: boolean; onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      }
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`h-screen flex items-center justify-center ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-gray-50'}`}>
      <form onSubmit={handleSubmit} className={`p-8 rounded-xl shadow-lg w-80 ${isDarkMode ? 'bg-gray-900 text-gray-100' : 'bg-white text-gray-900'}`}>
        <h2 className="text-lg font-semibold mb-4">Rollout Visualizer</h2>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
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
      }
    } catch {
      setError('Connection failed');
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
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
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
  // Presentation Mode is owned here so the left panel can swap in a live
  // capture preview; `presentationPreview` holds the rendered PNG's object
  // URL (for display) and the Blob itself (for a reliable copy / download).
  const [isPresentationMode, setIsPresentationMode] = useState(false);
  // "Discuss this rollout" chat — replaces the left panel when open. Mutually
  // exclusive with Presentation Mode.
  const [isRolloutChatOpen, setIsRolloutChatOpen] = useState(false);
  const [presentationPreview, setPresentationPreview] = useState<{ url: string; blob: Blob } | null>(null);
  // Capture settings — lifted here so the left-panel preview can host them.
  // Width + font-size are restored from the user's last session; image
  // theme always starts light (a capture defaults to light by design).
  const [imageTheme, setImageTheme] = useState<'light' | 'dark'>('light');
  const [exportWidth, setExportWidth] = useState<ExportWidth>(loadCaptureWidth);
  const [fontSize, setFontSize] = useState<FontSize>(loadCaptureFontSize);
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
      setIsPresentationMode(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPresentationMode]);
  const { loading, error, loadSamples, loadFilesProgressively, loadMultipleSamplesFull, loadSingleSample, messagesLoaded } = useApi(shareToken);
  const { markedFiles, toggleMark } = useMarkedFiles();
  const { isDarkMode, toggleDarkMode } = useDarkMode();
  const { getUrlState, setUrlState, generateLink } = useUrlState();
  const isSharedMode = authState === 'shared';
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
    } else {
      setFilePaths(['sample_rollout_traces.jsonl']);
    }
    if (urlState.message !== undefined) {
      setHighlightedMessageIndex(urlState.message);
    }
    if (urlState.highlight) {
      setHighlightedText(urlState.highlight);
    }
  }, [getUrlState]);

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

    // Phase 1: progressive per-file metadata loading
    loadFilesProgressively(filePaths, (fileSamples, _filePath) => {
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

      // Phase 2: full load in background → hydrate messages
      // Preserve currently selected sample across the replacement
      // NOTE: Use selectedSampleIdRef (not selectedSampleId) to avoid stale closure —
      // selectedSampleId was null when this effect created, but user may have selected
      // a sample during Phase 1 by the time this .then() fires.
      loadMultipleSamplesFull(filePaths).then((fullData) => {
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
    });
  }, [filePaths, authState, isSharedMode, shareInfo, loadSamples, loadFilesProgressively, loadMultipleSamplesFull, getUrlState]);

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
          ? { ...s, messages: singleSample.messages, grades: singleSample.grades ?? s.grades }
          : s
      ));
    });
  }, [selectedSampleId, messagesLoaded, samples, filePaths, loadSingleSample]);

  // Select a sample and clear highlights (used when user clicks a sample)
  const handleSelectSample = (id: number) => {
    setSelectedSampleId(id);
    // Clear any highlights and grade selection when user manually changes sample
    setHighlightedMessageIndex(null);
    setHighlightedText(null);
    setSelectedGradeMetric(undefined);
  };

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

  // Get the actual file path for links (use sample's source file or primary file)
  const getFilePathForSample = (sample: Sample | null): string => {
    return sample?.attributes.source_file || primaryFilePath;
  };

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

  const handleNavigate = (direction: 'first' | 'prev' | 'next' | 'last') => {
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
  };

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

      <PanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <Panel id="left" defaultSize="35%" minSize="10%" maxSize="90%">
          {isPresentationMode ? (
            <PresentationPreviewPanel
              imageUrl={presentationPreview?.url ?? null}
              imageBlob={presentationPreview?.blob ?? null}
              isDarkMode={isDarkMode}
              imageTheme={imageTheme}
              exportWidth={exportWidth}
              fontSize={fontSize}
              onImageThemeChange={setImageTheme}
              onExportWidthChange={setExportWidth}
              onFontSizeChange={setFontSize}
            />
          ) : isRolloutChatOpen ? (
            <RolloutChatPanel
              key={selectedSample?.id ?? 'no-sample'}
              sample={selectedSample}
              isDarkMode={isDarkMode}
              onClose={() => setIsRolloutChatOpen(false)}
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
            isDarkMode={isDarkMode}
            onToggleDarkMode={toggleDarkMode}
            onFilteredSamplesChange={setFilteredSamples}
            onCurrentOccurrenceIndexChange={setCurrentOccurrenceIndex}
            messagesLoaded={messagesLoaded}
            isSharedMode={isSharedMode}
          />
          )}
        </Panel>
        
        <PanelResizeHandle className={`w-1 ${isDarkMode ? 'bg-gray-700 hover:bg-gray-500' : 'bg-gray-200 hover:bg-gray-400'} transition-colors cursor-col-resize`} />
        
        <Panel id="right" defaultSize="65%" minSize="10%">
          <RightPanel
            sample={selectedSample}
            filteredSamples={filteredSamples}
            experimentName={experimentName}
            totalSamples={samples.length}
            onNavigate={handleNavigate}
            searchConditions={searchConditions}
            currentOccurrenceIndex={currentOccurrenceIndex}
            isDarkMode={isDarkMode}
            filePath={getFilePathForSample(selectedSample)}
            generateLink={generateLinkWithIndex}
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
            onTogglePresentationMode={() => { setIsRolloutChatOpen(false); setIsPresentationMode((v) => !v); }}
            isRolloutChatOpen={isRolloutChatOpen}
            onToggleRolloutChat={() => { setIsPresentationMode(false); setIsRolloutChatOpen((v) => !v); }}
            onPresentationPreview={(url, blob) => setPresentationPreview(url && blob ? { url, blob } : null)}
            imageTheme={imageTheme}
            exportWidth={exportWidth}
            fontSize={fontSize}
          />
        </Panel>
      </PanelGroup>

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

      {/* Grading Panel Modal — hidden in shared mode */}
      {!isSharedMode && isGradingPanelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className={`relative w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto rounded-xl shadow-2xl ${isDarkMode ? 'bg-gray-900' : 'bg-white'}`}>
            <button
              onClick={() => setIsGradingPanelOpen(false)}
              className={`absolute top-3 right-3 p-1 rounded-lg ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
            <div className="p-4">
              <Suspense fallback={
                <div className={`flex items-center justify-center p-8 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  <span className="material-symbols-outlined animate-spin" style={{ fontSize: 32 }}>progress_activity</span>
                </div>
              }>
                <GradingPanel
                  filteredSampleIds={filteredSamples.map(s => s.id)}
                  filePath={primaryFilePath}
                  isDarkMode={isDarkMode}
                  onGradingComplete={handleGradingComplete}
                  grading={grading}
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {/* Floating Grade Button — hidden in shared mode */}
      {!isSharedMode && samples.length > 0 && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2">
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
            onClick={() => setIsGradingPanelOpen(true)}
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
