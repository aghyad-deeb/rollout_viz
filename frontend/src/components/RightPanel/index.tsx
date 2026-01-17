import type { Sample, SearchField } from '../../types';
import { NavigationBar } from './NavigationBar';
import { ChatView } from './ChatView';

interface RightPanelProps {
  sample: Sample | null;
  experimentName: string;
  totalSamples: number;
  onNavigate: (direction: 'first' | 'prev' | 'next' | 'last') => void;
  searchTerm: string;
  searchField: SearchField;
  isDarkMode: boolean;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; message?: number; highlight?: string }) => string;
  highlightedMessageIndex: number | null;
  highlightedText: string | null;
  onClearHighlight: () => void;
}

export function RightPanel({
  sample,
  experimentName,
  totalSamples,
  onNavigate,
  searchTerm,
  searchField,
  isDarkMode,
  filePath,
  generateLink,
  highlightedMessageIndex,
  highlightedText,
  onClearHighlight,
}: RightPanelProps) {
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
      />
      
      <div className="flex-1 overflow-hidden">
        {sample ? (
          <ChatView 
            sample={sample} 
            searchTerm={searchTerm}
            searchField={searchField}
            isDarkMode={isDarkMode}
            filePath={filePath}
            generateLink={generateLink}
            highlightedMessageIndex={highlightedMessageIndex}
            highlightedText={highlightedText}
            onClearHighlight={onClearHighlight}
          />
        ) : (
          <div className={`h-full flex items-center justify-center ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            <div className="text-center">
              <span className="material-symbols-outlined" style={{ fontSize: 48 }}>chat</span>
              <p className="mt-2">Select a sample to view the conversation</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
