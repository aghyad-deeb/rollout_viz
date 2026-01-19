import { useState, useEffect, useRef, useCallback } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { FileBrowser } from './components/FileBrowser';
import { GradingPanel } from './components/GradingPanel';
import { useApi } from './hooks/useApi';
import { useMarkedFiles } from './hooks/useMarkedFiles';
import { useDarkMode } from './hooks/useDarkMode';
import { useUrlState } from './hooks/useUrlState';
import { useGrading } from './hooks/useGrading';
import type { Sample, SearchCondition, SearchLogic } from './types';

// Helper to generate unique IDs
const generateId = () => Math.random().toString(36).substring(2, 9);

function App() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [filteredSamples, setFilteredSamples] = useState<Sample[]>([]);
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [selectedGradeMetric, _setSelectedGradeMetric] = useState<string | undefined>(undefined);
  const [isGradingPanelOpen, setIsGradingPanelOpen] = useState(false);
  const { loading, error, loadSamples, loadMultipleSamples } = useApi();
  const { markedFiles, toggleMark } = useMarkedFiles();
  const { isDarkMode, toggleDarkMode } = useDarkMode();
  const { getUrlState, setUrlState, generateLink } = useUrlState();
  const grading = useGrading();
  const initialLoadDone = useRef(false);
  const isUserAction = useRef(false);

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

  // Load samples when file paths change
  useEffect(() => {
    if (filePaths.length === 0) return;
    
    if (filePaths.length === 1) {
      // Single file - use simple loading
      loadSamples(filePaths[0]).then((data) => {
        if (data) {
          setSamples(data.samples);
          setExperimentName(data.experiment_name);
          
          // Check URL for rollout_n to find the specific sample
          const urlState = getUrlState();
          if (urlState.rollout !== undefined) {
            const targetSample = data.samples.find(s => s.attributes.rollout_n === urlState.rollout);
            if (targetSample) {
              setSelectedSampleId(targetSample.id);
            } else if (data.samples.length > 0) {
              setSelectedSampleId(data.samples[0].id);
            }
          } else if (data.samples.length > 0 && selectedSampleId === null) {
            setSelectedSampleId(data.samples[0].id);
          }
        }
      });
    } else {
      // Multiple files - load and combine
      loadMultipleSamples(filePaths).then((data) => {
        if (data) {
          setSamples(data.samples);
          setExperimentName(data.experiment_name);
          
          if (data.samples.length > 0 && selectedSampleId === null) {
            setSelectedSampleId(data.samples[0].id);
          }
        }
      });
    }
  }, [filePaths, loadSamples, loadMultipleSamples, getUrlState]);

  // Only update URL on user-initiated sample selection (not on initial load)
  const handleSelectSampleWithUrlUpdate = (id: number) => {
    isUserAction.current = true;
    setSelectedSampleId(id);
    // Clear any highlights when user manually changes sample
    setHighlightedMessageIndex(null);
    setHighlightedText(null);
  };

  // Update URL only when user changes sample
  useEffect(() => {
    if (filePaths.length === 0 || samples.length === 0 || !isUserAction.current) return;
    
    const selectedSample = samples.find(s => s.id === selectedSampleId);
    // Use the sample's source file if available, otherwise use primary file
    const fileForUrl = selectedSample?.attributes.source_file || primaryFilePath;
    setUrlState({
      file: fileForUrl,
      rollout: selectedSample?.attributes.rollout_n,
    });
    isUserAction.current = false;
  }, [filePaths, primaryFilePath, selectedSampleId, samples, setUrlState]);

  const selectedSample = samples.find(s => s.id === selectedSampleId) || null;
  
  // Get the actual file path for links (use sample's source file or primary file)
  const getFilePathForSample = (sample: Sample | null): string => {
    return sample?.attributes.source_file || primaryFilePath;
  };

  const handleNavigate = (direction: 'first' | 'prev' | 'next' | 'last') => {
    if (samples.length === 0) return;
    
    const currentIndex = samples.findIndex(s => s.id === selectedSampleId);
    let newIndex: number;
    
    switch (direction) {
      case 'first':
        newIndex = 0;
        break;
      case 'prev':
        newIndex = Math.max(0, currentIndex - 1);
        break;
      case 'next':
        newIndex = Math.min(samples.length - 1, currentIndex + 1);
        break;
      case 'last':
        newIndex = samples.length - 1;
        break;
    }
    
    setSelectedSampleId(samples[newIndex].id);
  };

  // Reload samples after grading to pick up the viz/ version with grades
  const handleGradingComplete = useCallback(() => {
    if (filePaths.length === 0) return;
    
    if (filePaths.length === 1) {
      loadSamples(filePaths[0]).then((data) => {
        if (data) {
          setSamples(data.samples);
        }
      });
    } else {
      loadMultipleSamples(filePaths).then((data) => {
        if (data) {
          setSamples(data.samples);
        }
      });
    }
  }, [filePaths, loadSamples, loadMultipleSamples]);

  return (
    <div className={`h-screen ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
      <PanelGroup orientation="horizontal" className="h-full">
        <Panel id="left" defaultSize="35%" minSize="10%" maxSize="90%">
          <LeftPanel
            samples={samples}
            selectedSampleId={selectedSampleId}
            onSelectSample={handleSelectSampleWithUrlUpdate}
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
              <GradingPanel
                filteredSampleIds={filteredSamples.map(s => s.id)}
                filePath={primaryFilePath}
                isDarkMode={isDarkMode}
                onGradingComplete={handleGradingComplete}
                grading={grading}
              />
            </div>
          </div>
        </div>
      )}

      {/* Floating Grade Button with Progress */}
      {samples.length > 0 && (
        <button
          onClick={() => setIsGradingPanelOpen(true)}
          className={`fixed bottom-6 right-6 rounded-full shadow-lg transition-all z-40 flex items-center gap-2
            ${grading.progress.isRunning 
              ? (isDarkMode ? 'bg-purple-700 text-white px-4 py-3' : 'bg-purple-600 text-white px-4 py-3')
              : (isDarkMode ? 'bg-purple-600 hover:bg-purple-500 text-white p-4' : 'bg-purple-500 hover:bg-purple-600 text-white p-4')
            }`}
          title={grading.progress.isRunning ? grading.progress.statusMessage : "Grade samples with LLM"}
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
      )}
    </div>
  );
}

export default App;
