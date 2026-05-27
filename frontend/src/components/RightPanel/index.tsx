import { useState, lazy, Suspense } from 'react';
import type { Sample, ViewMode, SearchCondition, ExportWidth, FontSize } from '../../types';
import type { PresentationMessageDrafts } from '../../utils/presentationDraft';
import { NavigationBar } from './NavigationBar';
import { ChatView } from './ChatView';

const AnalysisView = lazy(() => import('./AnalysisView').then(m => ({ default: m.AnalysisView })));

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
  generateLink: (options: { file: string; rollout?: number; step?: number; message?: number; highlight?: string }) => string;
  highlightedMessageIndex: number | null;
  highlightedText: string | null;
  onClearHighlight: () => void;
  selectedGradeMetric?: string;
  onSelectGradeMetric?: (metric: string | undefined) => void;
  isSharedMode?: boolean;
  shareToken?: string | null;
  // Position of the selected sample inside its JSONL file — passed to share
  // link creation so the backend can pin the recipient to the exact row.
  selectedIndexInFile?: number;
  // Presentation Mode + capture settings — lifted to App so the left panel
  // can show the preview and host the capture-settings controls.
  isPresentationMode?: boolean;
  onTogglePresentationMode?: () => void;
  // "Discuss this rollout" chat toggle.
  isRolloutChatOpen?: boolean;
  onToggleRolloutChat?: () => void;
  onPresentationPreview?: (url: string | null, blob?: Blob | null) => void;
  imageTheme?: 'light' | 'dark';
  exportWidth?: ExportWidth;
  fontSize?: FontSize;
  presentationDrafts?: PresentationMessageDrafts;
  presentationActiveIndex?: number | null;
  onPresentationActiveIndexChange?: (index: number | null) => void;
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
  isSharedMode = false,
  shareToken,
  selectedIndexInFile,
  isPresentationMode = false,
  onTogglePresentationMode,
  isRolloutChatOpen = false,
  onToggleRolloutChat,
  onPresentationPreview,
  imageTheme = 'light',
  exportWidth = 'paper1',
  fontSize = 'md',
  presentationDrafts = {},
  presentationActiveIndex = null,
  onPresentationActiveIndexChange,
}: RightPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');

  // The right panel always follows the app UI theme. The capture's image
  // theme is independent and applied only to the off-screen capture render
  // (in ChatView), so toggling it no longer re-themes this panel.

  const renderContent = () => {
    if (viewMode === 'analysis') {
      return (
        <Suspense fallback={
          <div className={`h-full flex items-center justify-center ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            <span className="material-symbols-outlined animate-spin" style={{ fontSize: 32 }}>progress_activity</span>
          </div>
        }>
          <AnalysisView samples={filteredSamples} isDarkMode={isDarkMode} />
        </Suspense>
      );
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
          key={sample.id}
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
          isSharedMode={isSharedMode}
          shareToken={shareToken}
          selectedIndexInFile={selectedIndexInFile}
          isPresentationMode={isPresentationMode}
          imageTheme={imageTheme}
          exportWidth={exportWidth}
          fontSize={fontSize}
          onPresentationPreview={onPresentationPreview}
          presentationDrafts={presentationDrafts}
          presentationActiveIndex={presentationActiveIndex}
          onPresentationActiveIndexChange={onPresentationActiveIndexChange}
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
        isSharedMode={isSharedMode}
        highlightedMessageIndex={highlightedMessageIndex}
        highlightedText={highlightedText}
        shareToken={shareToken}
        selectedIndexInFile={selectedIndexInFile}
        isPresentationMode={isPresentationMode}
        onTogglePresentationMode={onTogglePresentationMode}
        isRolloutChatOpen={isRolloutChatOpen}
        onToggleRolloutChat={onToggleRolloutChat}
      />
      
      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}
