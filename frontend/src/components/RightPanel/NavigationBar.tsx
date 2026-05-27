import { useState } from 'react';
import type { Sample, ViewMode } from '../../types';
import { PUBLIC_BASE_URL } from '../../config';
import { toExactPrefillEnvelope } from '../../utils/exportPrefill';

interface NavigationBarProps {
  sample: Sample | null;
  experimentName: string;
  totalSamples: number;
  onNavigate: (direction: 'first' | 'prev' | 'next' | 'last') => void;
  isDarkMode: boolean;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; step?: number; message?: number; highlight?: string }) => string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  isSharedMode?: boolean;
  highlightedMessageIndex?: number | null;
  highlightedText?: string | null;
  shareToken?: string | null;
  // Needed so the share token can disambiguate samples that collide on
  // (rollout_n, step). Undefined when no sample is selected.
  selectedIndexInFile?: number;
  // Presentation Mode toggle.
  isPresentationMode?: boolean;
  onTogglePresentationMode?: () => void;
  // "Discuss this rollout" chat toggle.
  isRolloutChatOpen?: boolean;
  onToggleRolloutChat?: () => void;
}

export function NavigationBar({
  sample,
  experimentName,
  totalSamples,
  onNavigate,
  isDarkMode,
  filePath,
  generateLink,
  viewMode,
  onViewModeChange,
  isSharedMode = false,
  highlightedMessageIndex,
  highlightedText,
  shareToken,
  selectedIndexInFile,
  isPresentationMode = false,
  onTogglePresentationMode,
  isRolloutChatOpen = false,
  onToggleRolloutChat,
}: NavigationBarProps) {
  void totalSamples;

  const [shareCopied, setShareCopied] = useState(false);
  const [conversationCopied, setConversationCopied] = useState(false);

  const copyLink = () => {
    const link = generateLink({
      file: filePath,
      rollout: sample?.attributes.rollout_n,
      step: sample?.attributes.step,
    });
    navigator.clipboard.writeText(link);
  };

  const createShareLink = async () => {
    if (!sample) return;
    try {
      let token = shareToken;
      if (!token) {
        const response = await fetch('/api/share/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: filePath,
            rollout: sample.attributes.rollout_n,
            step: sample.attributes.step,
            // Without this, two samples with the same (rollout, step) would
            // both pass the backend filter and the recipient would see
            // whichever one came first in the file.
            index: selectedIndexInFile,
          }),
        });
        if (!response.ok) return;
        const data = await response.json();
        token = data.token;
      }
      if (token) {
        const params = new URLSearchParams({ share: token });
        if (highlightedMessageIndex != null) params.set('message', highlightedMessageIndex.toString());
        if (highlightedText) params.set('highlight', highlightedText);
        const url = `${PUBLIC_BASE_URL}/?${params.toString()}`;
        navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch { /* ignore */ }
  };

  // Copy the conversation as an Exact Prefill v2 envelope for auto_eval.
  // This preserves replay metadata and raw archival fields instead of a
  // lossy `{ role, content }` transcript.
  const copyConversation = async () => {
    if (!sample) return;
    const envelope = toExactPrefillEnvelope(sample, {
      file: filePath,
      highlighted_message_index: highlightedMessageIndex,
      selected_index_in_file: selectedIndexInFile,
    });
    try {
      await navigator.clipboard.writeText(JSON.stringify(envelope, null, 2));
      setConversationCopied(true);
      setTimeout(() => setConversationCopied(false), 2000);
    } catch {
      // Browser blocked the clipboard write (no user gesture, missing
      // permission, etc.). Stay silent — the share-link path does the same.
    }
  };

  const btnClass = isDarkMode 
    ? 'text-gray-300 bg-gray-700 hover:bg-gray-600' 
    : 'text-gray-600 bg-gray-200 hover:bg-gray-300';

  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 border-b ${isDarkMode ? 'bg-[#16213e] border-gray-700' : 'bg-white border-gray-200'}`}>
      {/* View mode toggle */}
      <div className="flex items-center">
        <div className={`flex h-9 rounded-md border overflow-hidden mr-4 ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'eval' 
                ? 'bg-sky-600 text-white' 
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } rounded-l-md`}
            onClick={() => onViewModeChange('eval')}
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
            onClick={() => onViewModeChange('meta')}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>candlestick_chart</span>
            Meta
          </button>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'chat' 
                ? 'bg-sky-600 text-white' 
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            onClick={() => onViewModeChange('chat')}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>chat</span>
            Chat
          </button>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'analysis' 
                ? 'bg-sky-600 text-white' 
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } rounded-r-md border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            onClick={() => onViewModeChange('analysis')}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>analytics</span>
            Analysis
          </button>
        </div>
      </div>

      {/* Navigation controls */}
      <div className="flex-auto flex flex-wrap items-center gap-x-6 gap-y-2 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="w-full flex items-center justify-between gap-2">
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
                {!isSharedMode && (
                  <button
                    className={`flex items-center justify-center w-7 h-7 rounded-md ml-2 ${btnClass}`}
                    title="Copy link to this sample"
                    onClick={copyLink}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>link</span>
                  </button>
                )}
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
        <div className="flex items-center gap-1 shrink-0">
          <button
            className={`flex items-center justify-center h-7 rounded-md px-2 disabled:opacity-50 ${
              isRolloutChatOpen ? 'bg-sky-600 text-white' : btnClass
            }`}
            title="Discuss this rollout with a frontier model"
            onClick={() => onToggleRolloutChat?.()}
            disabled={!sample}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>forum</span>
            {isRolloutChatOpen && <span className="text-xs ml-1 font-medium">Discussing</span>}
          </button>
          <button
            className={`flex items-center justify-center h-7 rounded-md px-2 ${
              isPresentationMode
                ? 'bg-sky-600 text-white'
                : btnClass
            }`}
            title={isPresentationMode ? 'Exit Presentation Mode' : 'Presentation Mode (P) — collapse text & capture rollout images'}
            onClick={() => onTogglePresentationMode?.()}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>slideshow</span>
            {isPresentationMode && <span className="text-xs ml-1 font-medium">Presenting</span>}
          </button>
          <button
            className={`flex items-center justify-center h-7 rounded-md disabled:opacity-50 ${
              conversationCopied
                ? 'bg-green-600 text-white px-2'
                : `w-7 ${btnClass}`
            }`}
            title="Copy Exact Prefill v2 JSON for auto_eval"
            onClick={copyConversation}
            disabled={!sample}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
              {conversationCopied ? 'check' : 'content_copy'}
            </span>
            {conversationCopied && <span className="text-xs ml-1 font-medium">Copied</span>}
          </button>
          <button
            className={`flex items-center justify-center h-7 rounded-md disabled:opacity-50 ${
              shareCopied
                ? 'bg-green-600 text-white px-2'
                : isDarkMode ? 'text-emerald-400 bg-emerald-900 hover:bg-emerald-800 px-2' : 'text-emerald-700 bg-emerald-200 hover:bg-emerald-300 px-2'
            }`}
            title={isSharedMode ? "Copy share link" : "Create read-only share link"}
            onClick={createShareLink}
            disabled={!sample}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>share</span>
            {shareCopied && <span className="text-xs ml-1 font-medium">Copied</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
