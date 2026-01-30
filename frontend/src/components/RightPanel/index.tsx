import { useState } from 'react';
import type { Sample, ViewMode, SearchCondition } from '../../types';
import { NavigationBar } from './NavigationBar';
import { ChatView } from './ChatView';
import { AnalysisView } from './AnalysisView';

interface RightPanelProps {
  sample: Sample | null;
  filteredSamples: Sample[];
  experimentName: string;
  totalSamples: number;
  onNavigate: (direction: 'first' | 'prev' | 'next' | 'last') => void;
  searchConditions: SearchCondition[];
  currentOccurrenceIndex: number;
  isDarkMode: boolean;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; message?: number; highlight?: string }) => string;
  highlightedMessageIndex: number | null;
  highlightedText: string | null;
  onClearHighlight: () => void;
  selectedGradeMetric?: string;
  onSelectGradeMetric?: (metric: string | undefined) => void;
}

export function RightPanel({
  sample,
  filteredSamples,
  experimentName,
  totalSamples,
  onNavigate,
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
}: RightPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');

  const renderContent = () => {
    if (viewMode === 'analysis') {
      return <AnalysisView samples={filteredSamples} isDarkMode={isDarkMode} />;
    }

    // Chat view (default) and placeholders for eval/meta
    if (viewMode === 'eval' || viewMode === 'meta') {
      return (
        <div className={`h-full flex items-center justify-center ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          <div className="text-center">
            <span className="material-symbols-outlined" style={{ fontSize: 48 }}>
              {viewMode === 'eval' ? 'dashboard' : 'candlestick_chart'}
            </span>
            <p className="mt-2">{viewMode === 'eval' ? 'Eval' : 'Meta'} view coming soon</p>
          </div>
        </div>
      );
    }

    // Chat view
    if (sample) {
      return (
        <ChatView 
          sample={sample} 
          searchConditions={searchConditions}
          currentOccurrenceIndex={currentOccurrenceIndex}
          isDarkMode={isDarkMode}
          filePath={filePath}
          generateLink={generateLink}
          highlightedMessageIndex={highlightedMessageIndex}
          highlightedText={highlightedText}
          onClearHighlight={onClearHighlight}
          selectedGradeMetric={selectedGradeMetric}
          onSelectGradeMetric={onSelectGradeMetric}
        />
      );
    }

    return (
      <div className={`h-full flex items-center justify-center ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
        <div className="text-center">
          <span className="material-symbols-outlined" style={{ fontSize: 48 }}>chat</span>
          <p className="mt-2">Select a sample to view the conversation</p>
        </div>
      </div>
    );
  };

  return (
    <div className={`h-full flex flex-col ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
      <NavigationBar
        sample={sample}
        experimentName={experimentName}
        totalSamples={totalSamples}
        onNavigate={onNavigate}
        isDarkMode={isDarkMode}
        filePath={filePath}
        generateLink={generateLink}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />
      
      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}
