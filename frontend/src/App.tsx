import { useState, useEffect, useRef } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { FileBrowser } from './components/FileBrowser';
import { useApi } from './hooks/useApi';
import { useMarkedFiles } from './hooks/useMarkedFiles';
import { useDarkMode } from './hooks/useDarkMode';
import { useUrlState } from './hooks/useUrlState';
import type { Sample, SearchField } from './types';

function App() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [filteredSamples, setFilteredSamples] = useState<Sample[]>([]);
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
  const [experimentName, setExperimentName] = useState<string>('');
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [searchField, setSearchField] = useState<SearchField>('chat');
  const [highlightedMessageIndex, setHighlightedMessageIndex] = useState<number | null>(null);
  const [highlightedText, setHighlightedText] = useState<string | null>(null);
  const { loading, error, loadSamples, loadMultipleSamples } = useApi();
  const { markedFiles, toggleMark } = useMarkedFiles();
  const { isDarkMode, toggleDarkMode } = useDarkMode();
  const { getUrlState, setUrlState, generateLink } = useUrlState();
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
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            searchField={searchField}
            onSearchFieldChange={setSearchField}
            loading={loading}
            error={error}
            isDarkMode={isDarkMode}
            onToggleDarkMode={toggleDarkMode}
            onFilteredSamplesChange={setFilteredSamples}
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
            searchTerm={searchTerm}
            searchField={searchField}
            isDarkMode={isDarkMode}
            filePath={getFilePathForSample(selectedSample)}
            generateLink={generateLink}
            highlightedMessageIndex={highlightedMessageIndex}
            highlightedText={highlightedText}
            onClearHighlight={() => {
              setHighlightedMessageIndex(null);
              setHighlightedText(null);
            }}
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
    </div>
  );
}

export default App;
