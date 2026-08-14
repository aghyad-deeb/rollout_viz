import { useState } from 'react';
import type { Sample, ViewMode } from '../../types';
import { buildPublicUrl } from '../../config';
import { toExactPrefillEnvelope } from '../../utils/exportPrefill';

interface NavigationBarProps {
  sample: Sample | null;
  experimentName: string;
  // Position of the selected sample within the filtered list (-1 when no
  // sample is selected) and the list's length — drives the "n / m" indicator
  // and boundary-disabling of the nav arrows.
  navPos: number;
  navTotal: number;
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
  // Triage Mode toggle (record human verdicts with 1-4).
  isTriageMode?: boolean;
  onToggleTriageMode?: () => void;
  // "Discuss this rollout" chat toggle.
  isRolloutChatOpen?: boolean;
  onToggleRolloutChat?: () => void;
  // Base URL of the web_chat deployment (from /api/config); null hides the
  // "Open in web_chat" action.
  webChatBaseUrl?: string | null;
  // "Run files" drawer (companion files next to the loaded rollout file).
  isCompanionOpen?: boolean;
  onToggleCompanions?: () => void;
  // Per-rollout comments drawer + how many the selected sample already has.
  isCommentsOpen?: boolean;
  commentCount?: number;
  onToggleComments?: () => void;
  /** Unposted draft or failed save on this rollout — shows an amber dot. */
  commentsAttention?: boolean;
  /** Lets the drawer hand focus back here when it closes (X / Escape). */
  commentsToggleRef?: React.RefObject<HTMLButtonElement | null>;
}

export function NavigationBar({
  sample,
  experimentName,
  navPos,
  navTotal,
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
  isTriageMode = false,
  onToggleTriageMode,
  isRolloutChatOpen = false,
  onToggleRolloutChat,
  webChatBaseUrl = null,
  isCompanionOpen = false,
  onToggleCompanions,
  isCommentsOpen = false,
  commentCount = 0,
  onToggleComments,
  commentsAttention = false,
  commentsToggleRef,
}: NavigationBarProps) {
  const [shareCopied, setShareCopied] = useState(false);
  const [conversationCopied, setConversationCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // Boundary checks against the filtered list: navPos is -1 when no sample is
  // selected (or the selected one fell out of the filter).
  const atStart = !sample || navPos <= 0;
  const atEnd = !sample || navPos < 0 || navPos >= navTotal - 1;

  // "Open in web_chat" round trip: chats logged by web_chat carry chat_id in
  // their attributes and live under s3://rewardseeker/ — web_chat reloads
  // them by S3 key (?chat=<key>&branch=<id>). Hidden unless the server
  // config provides a web_chat base URL.
  const webChatUrl = (() => {
    if (!sample || !webChatBaseUrl) return null;
    const chatId = sample.attributes.chat_id;
    if (typeof chatId !== 'string' || !chatId) return null;
    const S3_PREFIX = 's3://rewardseeker/';
    if (!filePath.startsWith(S3_PREFIX)) return null;
    const params = new URLSearchParams({ chat: filePath.slice(S3_PREFIX.length) });
    const branch = sample.attributes.branch_id;
    if (typeof branch === 'string' && branch) params.set('branch', branch);
    return `${webChatBaseUrl}/?${params.toString()}`;
  })();

  const copyLink = async () => {
    const link = generateLink({
      file: filePath,
      rollout: sample?.attributes.rollout_n,
      step: sample?.attributes.step,
    });
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Browser blocked the clipboard write — stay silent, like the other
      // copy buttons.
    }
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
        const url = buildPublicUrl(params);
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
              viewMode === 'chat'
                ? 'bg-sky-600 text-white'
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } rounded-l-md`}
            onClick={() => onViewModeChange('chat')}
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>chat</span>
            Chat
          </button>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'analysis'
                ? 'bg-sky-600 text-white'
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            onClick={() => onViewModeChange('analysis')}
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>analytics</span>
            Analysis
          </button>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 ${
              viewMode === 'evidence'
                ? 'bg-sky-600 text-white'
                : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-50'
            } border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            title="Browse all grader quotes for a metric across the loaded rollouts"
            onClick={() => onViewModeChange('evidence')}
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>fact_check</span>
            Evidence
          </button>
          {/* Eval and Meta are unimplemented placeholders — disabled until their views land. */}
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed ${
              viewMode === 'eval'
                ? 'bg-sky-600 text-white'
                : isDarkMode ? 'bg-gray-800 text-gray-300' : 'bg-white text-gray-700'
            } border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            title="Coming soon"
            onClick={() => onViewModeChange('eval')}
            disabled
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>dashboard</span>
            Eval
          </button>
          <button
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed ${
              viewMode === 'meta'
                ? 'bg-sky-600 text-white'
                : isDarkMode ? 'bg-gray-800 text-gray-300' : 'bg-white text-gray-700'
            } rounded-r-md border-l ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
            title="Coming soon"
            onClick={() => onViewModeChange('meta')}
            disabled
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>candlestick_chart</span>
            Meta
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
                aria-label="First sample"
                onClick={() => onNavigate('first')}
                disabled={atStart}
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>keyboard_double_arrow_left</span>
              </button>
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 ${btnClass}`}
                title="Previous sample (K)"
                aria-label="Previous sample (K)"
                onClick={() => onNavigate('prev')}
                disabled={atStart}
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>keyboard_arrow_left</span>
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
                  {navPos >= 0 && (
                    <span className={`text-xs whitespace-nowrap ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      {navPos + 1} / {navTotal}
                    </span>
                  )}
                  {(sample?.diagnostics?.length ?? 0) > 0 && (
                    <span
                      className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap cursor-help ${
                        isDarkMode ? 'bg-amber-900/50 text-amber-300' : 'bg-amber-100 text-amber-700'
                      }`}
                      title={`Producer diagnostics:\n${sample!.diagnostics!.join('\n')}`}
                    >
                      diag
                    </span>
                  )}
                </div>
                {!isSharedMode && (
                  <button
                    className={`flex items-center justify-center h-7 rounded-md ml-2 ${
                      linkCopied
                        ? 'bg-green-600 text-white px-2'
                        : `w-7 ${btnClass}`
                    }`}
                    title="Copy link to this sample"
                    aria-label="Copy link to this sample"
                    onClick={copyLink}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>
                      {linkCopied ? 'check' : 'link'}
                    </span>
                    {linkCopied && <span className="text-xs ml-1 font-medium">Copied</span>}
                  </button>
                )}
                {!isSharedMode && webChatUrl && (
                  <a
                    href={webChatUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-center justify-center w-7 h-7 rounded-md ml-1 ${btnClass}`}
                    title="Open this chat in web_chat"
                    aria-label="Open this chat in web_chat"
                  >
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>
                      forum
                    </span>
                  </a>
                )}
                {!isSharedMode && onToggleCompanions && sample && (
                  <button
                    onClick={onToggleCompanions}
                    className={`flex items-center justify-center w-7 h-7 rounded-md ml-1 ${
                      isCompanionOpen
                        ? (isDarkMode ? 'bg-indigo-900/60 text-indigo-300' : 'bg-indigo-100 text-indigo-700')
                        : btnClass
                    }`}
                    title="Run files — plan, summaries, and evaluator transcript next to this file"
                    aria-label="Toggle run files"
                  >
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>
                      folder_open
                    </span>
                  </button>
                )}
                {!isSharedMode && onToggleComments && sample && (
                  <button
                    ref={commentsToggleRef}
                    onClick={onToggleComments}
                    className={`relative flex items-center justify-center w-7 h-7 rounded-md ml-1 ${
                      isCommentsOpen
                        ? (isDarkMode ? 'bg-sky-900/60 text-sky-300' : 'bg-sky-100 text-sky-700')
                        : btnClass
                    }`}
                    title={`${commentCount > 0
                      ? `Comments (${commentCount})`
                      : 'Comments — leave a note on this rollout'}${
                      commentsAttention ? ' · unposted draft' : ''}`}
                    aria-label={`Comments (${commentCount})`}
                    aria-pressed={isCommentsOpen}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>
                      sticky_note_2
                    </span>
                    {commentCount > 0 && (
                      <span
                        aria-hidden="true"
                        className={`absolute -top-1 -right-1 min-w-[16px] h-[16px] px-[3px] rounded-full text-[10px] font-semibold leading-[16px] text-center font-data text-white ${
                          isDarkMode ? 'bg-sky-500' : 'bg-sky-600'
                        }`}
                      >
                        {commentCount > 9 ? '9+' : commentCount}
                      </span>
                    )}
                    {/* Unposted draft / failed save — deliberately a different
                        shape, color, and corner from the sky count badge. */}
                    {commentsAttention && (
                      <span
                        data-testid="comments-attention-dot"
                        aria-hidden="true"
                        className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ${
                          isDarkMode ? 'bg-amber-400 ring-[#16213e]' : 'bg-amber-500 ring-white'
                        }`}
                      />
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Right navigation buttons */}
            <div className="flex items-center space-x-1">
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 ${btnClass}`}
                title="Next sample (J)"
                aria-label="Next sample (J)"
                onClick={() => onNavigate('next')}
                disabled={atEnd}
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>keyboard_arrow_right</span>
              </button>
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 ${btnClass}`}
                title="Last sample"
                aria-label="Last sample"
                onClick={() => onNavigate('last')}
                disabled={atEnd}
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>keyboard_double_arrow_right</span>
              </button>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            className={`flex items-center justify-center h-7 rounded-md px-2 disabled:opacity-50 ${
              isTriageMode ? 'bg-indigo-600 text-white' : btnClass
            }`}
            title={isTriageMode ? 'Exit Triage Mode' : 'Triage Mode — record human verdicts with keys 1-4'}
            aria-label={isTriageMode ? 'Exit Triage Mode' : 'Enter Triage Mode'}
            onClick={() => onToggleTriageMode?.()}
            disabled={!sample && !isTriageMode}
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>checklist</span>
            {isTriageMode && <span className="text-xs ml-1 font-medium">Triaging</span>}
          </button>
          <button
            className={`flex items-center justify-center h-7 rounded-md px-2 disabled:opacity-50 ${
              isRolloutChatOpen ? 'bg-sky-600 text-white' : btnClass
            }`}
            title="Discuss this rollout with a frontier model"
            onClick={() => onToggleRolloutChat?.()}
            disabled={!sample}
          >
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>forum</span>
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
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>slideshow</span>
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
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>
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
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 17 }}>share</span>
            {shareCopied && <span className="text-xs ml-1 font-medium">Copied</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
