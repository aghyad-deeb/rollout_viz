import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { FileBrowser } from './components/FileBrowser';

const GradingPanel = lazy(() => import('./components/GradingPanel').then(m => ({ default: m.GradingPanel })));
import { useApi } from './hooks/useApi';
import { useMarkedFiles } from './hooks/useMarkedFiles';
import { useDarkMode } from './hooks/useDarkMode';
import { useUrlState } from './hooks/useUrlState';
import { useGrading } from './hooks/useGrading';
import type { Sample, SearchCondition, SearchLogic } from './types';

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

function App() {
  const [authState, setAuthState] = useState<'loading' | 'login' | 'ready'>('loading');
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
  const { loading, error, loadSamples, loadMultipleSamples, loadFilesProgressively, loadMultipleSamplesFull, loadSingleSample, messagesLoaded, messagesLoading } = useApi();
  const { markedFiles, toggleMark } = useMarkedFiles();
  const { isDarkMode, toggleDarkMode } = useDarkMode();
  const { getUrlState, setUrlState, generateLink } = useUrlState();
  const grading = useGrading();
  const initialLoadDone = useRef(false);

  // Check authentication on mount, with retry for backend startup
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 15; // ~15 seconds total
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
          return; // Success — stop retrying
        } catch {
          // Backend not ready yet — wait and retry
          if (!cancelled && attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, retryDelay));
          }
        }
      }
      // All retries exhausted — proceed without auth (backend may be down)
      if (!cancelled) setAuthState('ready');
    };

    tryAuthCheck();
    return () => { cancelled = true; };
  }, []);

  // Get the primary file path for display and URL (first file or the sample's source file)
  const primaryFilePath = filePaths.length > 0 ? filePaths[0] : '';

  // Initialize from URL on mount
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const urlState = getUrlState();
    if (urlState.file) {
      setFilePaths([urlState.file]);
    } else {
      // Default file if none in URL
      setFilePaths(['sample_rollout_traces.jsonl']);
    }
    // Set message highlight immediately if provided
    if (urlState.message !== undefined) {
      setHighlightedMessageIndex(urlState.message);
    }
    if (urlState.highlight) {
      setHighlightedText(urlState.highlight);
    }
  }, [getUrlState]);

  // Load samples when file paths change (only after authenticated)
  // Progressive per-file loading: fire individual metadata-only requests per file,
  // render each file's samples as they arrive (~2s for first file).
  // Then hydrate messages in background.
  useEffect(() => {
    if (filePaths.length === 0 || authState !== 'ready') return;

    // Clear samples before starting new load
    setSamples([]);
    setSelectedSampleId(null);

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
        if (urlState.rollout !== undefined) {
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
      if (urlState.rollout !== undefined) {
        setSamples(prev => {
          const found = prev.find(s =>
            Number(s.attributes.rollout_n) === urlState.rollout &&
            (urlState.step === undefined || Number(s.attributes.step) === urlState.step)
          );
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
          // Re-find the selected sample in the new dataset by rollout_n + step + source_file
          if (currentlySelected) {
            const match = newSamples.find(s =>
              Number(s.attributes.rollout_n) === Number(currentlySelected.attributes.rollout_n) &&
              Number(s.attributes.step) === Number(currentlySelected.attributes.step) &&
              (s.attributes.source_file || '') === (currentlySelected.attributes.source_file || '')
            );
            if (match) {
              setSelectedSampleId(match.id);
            }
          }
          return newSamples;
        });
      });
    });
  }, [filePaths, authState, loadFilesProgressively, loadMultipleSamplesFull, getUrlState]);

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

  // Update URL whenever the selected sample changes (user click, navigation, or auto-selection)
  useEffect(() => {
    if (filePaths.length === 0 || samples.length === 0 || selectedSampleId === null) return;

    const selectedSample = samples.find(s => s.id === selectedSampleId);
    if (!selectedSample) return;
    // Use the sample's source file if available, otherwise use primary file
    const fileForUrl = selectedSample.attributes.source_file || primaryFilePath;
    setUrlState({
      file: fileForUrl,
      rollout: selectedSample.attributes.rollout_n,
      step: selectedSample.attributes.step,
    });
  }, [filePaths, primaryFilePath, selectedSampleId, samples, setUrlState]);

  const selectedSample = samples.find(s => s.id === selectedSampleId) || null;
  
  // Get the actual file path for links (use sample's source file or primary file)
  const getFilePathForSample = (sample: Sample | null): string => {
    return sample?.attributes.source_file || primaryFilePath;
  };

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
  if (authState === 'login') {
    return <LoginOverlay isDarkMode={isDarkMode} onLogin={() => setAuthState('ready')} />;
  }

  return (
    <div className={`h-screen ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
      <PanelGroup orientation="horizontal" className="h-full">
        <Panel id="left" defaultSize="35%" minSize="10%" maxSize="90%">
          <LeftPanel
            samples={samples}
            selectedSampleId={selectedSampleId}
            onSelectSample={handleSelectSample}
            experimentName={experimentName}
            filePaths={filePaths}
            onFilePathsChange={setFilePaths}
            onOpenFileBrowser={() => setIsFileBrowserOpen(true)}
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
          />
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
            generateLink={generateLink}
            highlightedMessageIndex={highlightedMessageIndex}
            highlightedText={highlightedText}
            onClearHighlight={() => {
              setHighlightedMessageIndex(null);
              setHighlightedText(null);
            }}
            selectedGradeMetric={selectedGradeMetric}
            onSelectGradeMetric={setSelectedGradeMetric}
          />
        </Panel>
      </PanelGroup>

      {/* File Browser Modal */}
      <FileBrowser
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
        onSelectFiles={(paths) => {
          setFilePaths(paths);
          setSelectedSampleId(null); // Reset selection when loading new files
        }}
        markedFiles={markedFiles}
        onToggleMark={toggleMark}
        isDarkMode={isDarkMode}
      />

      {/* Grading Panel Modal */}
      {isGradingPanelOpen && (
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

      {/* Floating Grade Button with Progress */}
      {samples.length > 0 && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2">
          {/* Cancel button - only show when grading */}
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
          
          {/* Main grade button */}
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
                {/* Spinner */}
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
