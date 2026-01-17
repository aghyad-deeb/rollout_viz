import { useState } from 'react';
import type { Sample } from '../../types';

interface NavigationBarProps {
  sample: Sample | null;
  experimentName: string;
  totalSamples: number; // Used for display
  onNavigate: (direction: 'first' | 'prev' | 'next' | 'last') => void;
  isDarkMode: boolean;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; message?: number; highlight?: string }) => string;
}

type ViewMode = 'eval' | 'meta' | 'chat';

export function NavigationBar({
  sample,
  experimentName,
  totalSamples,
  onNavigate,
  isDarkMode,
  filePath,
  generateLink,
}: NavigationBarProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  void totalSamples; // Mark as intentionally unused for now

  const copyLink = () => {
    const link = generateLink({
      file: filePath,
      rollout: sample?.attributes.rollout_n,
    });
    navigator.clipboard.writeText(link);
  };

  const btnClass = isDarkMode 
    ? 'text-gray-300 bg-gray-700 hover:bg-gray-600' 
    : 'text-gray-600 bg-gray-200 hover:bg-gray-300';

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-2 border-b ${isDarkMode ? 'bg-[#16213e] border-gray-700' : 'bg-white border-gray-200'}`}>
      {/* View mode toggle */}
      <div className="flex items-center">
        <div className={`flex h-9 rounded-md border overflow-hidden mr-4 ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'eval' 
                ? 'bg-sky-600 text-white' 
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } rounded-l-md`}
            onClick={() => setViewMode('eval')}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>dashboard</span>
            Eval
          </button>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'meta' 
                ? 'bg-sky-600 text-white' 
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            onClick={() => setViewMode('meta')}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>candlestick_chart</span>
            Meta
          </button>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'chat' 
                ? 'bg-sky-600 text-white' 
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } rounded-r-md border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            onClick={() => setViewMode('chat')}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>chat</span>
            Chat
          </button>
        </div>
      </div>

      {/* Navigation controls */}
      <div className="flex-1 flex gap-6">
        <div className="flex-1">
          <div className="w-full flex items-center justify-between">
            {/* Left navigation buttons */}
            <div className="flex items-center space-x-1">
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 ${btnClass}`}
                title="First sample"
                onClick={() => onNavigate('first')}
                disabled={!sample}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>keyboard_double_arrow_left</span>
              </button>
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 ${btnClass}`}
                title="Previous sample"
                onClick={() => onNavigate('prev')}
                disabled={!sample}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>keyboard_arrow_left</span>
              </button>
            </div>

            {/* Sample info */}
            <div className="flex items-center gap-2">
              <div className="flex items-center">
                <div className="flex flex-col items-center">
                  <span className={`text-xs font-medium whitespace-nowrap ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {experimentName || 'No experiment'}
                  </span>
                  <span className={`text-sm font-medium whitespace-nowrap ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
                    {sample 
                      ? `sample ${sample.attributes.sample_index}, step ${sample.attributes.step}`
                      : 'No sample selected'
                    }
                  </span>
                </div>
                <button
                  className={`flex items-center justify-center w-7 h-7 rounded-md ml-2 ${btnClass}`}
                  title="Copy link to this sample"
                  onClick={copyLink}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>link</span>
                </button>
              </div>
            </div>

            {/* Right navigation buttons */}
            <div className="flex items-center space-x-1">
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 ${btnClass}`}
                title="Next sample"
                onClick={() => onNavigate('next')}
                disabled={!sample}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>keyboard_arrow_right</span>
              </button>
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 ${btnClass}`}
                title="Last sample"
                onClick={() => onNavigate('last')}
                disabled={!sample}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>keyboard_double_arrow_right</span>
              </button>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          <button
            className={`flex items-center justify-center w-7 h-7 rounded-md ${isDarkMode ? 'text-blue-400 bg-blue-900 hover:bg-blue-800' : 'text-blue-700 bg-blue-200 hover:bg-blue-300'}`}
            title="Download"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>download</span>
          </button>
        </div>
      </div>
    </div>
  );
}
