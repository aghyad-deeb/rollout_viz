import { useCallback, useMemo, useRef, useState, lazy, Suspense } from 'react';
import type { Sample, ViewMode, SearchCondition, ExportWidth, FontSize, GradeEntry } from '../../types';
import type { PresentationMessageDrafts } from '../../utils/presentationDraft';
import { NavigationBar } from './NavigationBar';
import { CompanionDrawer } from './CompanionDrawer';
import { CommentsPanel } from './CommentsPanel';
import { ChatView } from './ChatView';
import { EvidenceView } from './EvidenceView';
import { COMMENTS_METRIC, visibleComments } from '../../utils/humanGrades';

const AnalysisView = lazy(() => import('./AnalysisView').then(m => ({ default: m.AnalysisView })));

// Stable default for the presentationDrafts pass-through. An inline `= {}`
// default would mint a new identity on every render and defeat ChatView's
// own stable default — its displayedMessages memo (and the preview-capture
// effect behind it) key on this prop's identity.
const EMPTY_DRAFTS: PresentationMessageDrafts = {};

// Stable no-op for optional callback props, for the same identity reason.
const NOOP = () => {};

interface RightPanelProps {
  sample: Sample | null;
  filteredSamples: Sample[];
  experimentName: string;
  // View mode is owned by App — the Evidence view and triage hotkeys need
  // to coordinate with it (e.g. global J/K yields to the evidence feed).
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
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
  // Exits Presentation Mode (Escape / toolbar button) — forwarded to ChatView.
  onExitPresentationMode?: () => void;
  // Triage mode toggle (human verdicts) — surfaced in the NavigationBar.
  isTriageMode?: boolean;
  onToggleTriageMode?: () => void;
  // Evidence view plumbing: current annotator ('' = audits disabled), jump
  // from an evidence card into the chat at a quote, and record an audit.
  annotator?: string;
  onAnnotatorChange?: (name: string) => void;
  onOpenQuote?: (sampleId: number, messageIndex: number | null, highlightText: string | null) => void;
  onAudit?: (sampleId: number, metric: string, action: 'confirm' | 'dispute', judgeEntry: GradeEntry) => void;
  // Per-rollout comments (freeform human grade entries on the `comments`
  // metric). Absent = the comments toggle is hidden. Open state is owned by
  // App — the floating grading cluster has to move out of the drawer's way.
  onAddComment?: (sampleId: number, text: string) => Promise<boolean>;
  /** Soft-deletes a comment (appends a tombstone). Absent in shared mode. */
  onDeleteComment?: (sampleId: number, target: GradeEntry) => Promise<boolean>;
  isCommentsOpen?: boolean;
  onToggleComments?: () => void;
  // "Discuss this rollout" chat toggle.
  isRolloutChatOpen?: boolean;
  onToggleRolloutChat?: () => void;
  webChatBaseUrl?: string | null;
  onPresentationPreview?: (url: string | null, blob?: Blob | null) => void;
  onPreviewPending?: (pending: boolean) => void;
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
  viewMode,
  onViewModeChange,
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
  onExitPresentationMode,
  isTriageMode = false,
  onToggleTriageMode,
  annotator = '',
  onAnnotatorChange,
  onOpenQuote,
  onAudit,
  onAddComment,
  onDeleteComment,
  isCommentsOpen = false,
  onToggleComments,
  isRolloutChatOpen = false,
  onToggleRolloutChat,
  webChatBaseUrl = null,
  onPresentationPreview,
  onPreviewPending,
  imageTheme = 'light',
  exportWidth = 'paper1',
  fontSize = 'md',
  presentationDrafts = EMPTY_DRAFTS,
  presentationActiveIndex = null,
  onPresentationActiveIndexChange,
}: RightPanelProps) {
  const [isCompanionOpen, setIsCompanionOpen] = useState(false);
  // Once opened, the comments drawer stays mounted (hidden) so closing it
  // never discards a half-written comment — same latch App uses for the
  // grading modal. The latch lives here, next to the render it guards; the
  // open/closed flag itself is App's (the floating grading cluster shifts
  // out of the drawer's way).
  const [commentsMounted, setCommentsMounted] = useState(false);
  if (isCommentsOpen && !commentsMounted) setCommentsMounted(true);
  // Unposted draft / failed save on the current rollout — surfaced on the
  // toolbar toggle so closing the drawer doesn't hide it.
  const [commentsAttention, setCommentsAttention] = useState(false);
  // The drawer hands focus back to its toggle when it closes.
  const commentsToggleRef = useRef<HTMLButtonElement>(null);
  // Deleted comments (and their tombstones) are still in the log but must not
  // be counted on the badge — visibleComments is the one true reader.
  const commentCount = visibleComments(sample?.grades?.[COMMENTS_METRIC]).length;
  const handleCloseComments = useCallback(() => {
    if (isCommentsOpen) onToggleComments?.();
    commentsToggleRef.current?.focus();
  }, [isCommentsOpen, onToggleComments]);
  // Position of the selected sample within the filtered list — drives the
  // NavigationBar's "n / m" indicator and boundary-disabled arrows.
  const navTotal = filteredSamples.length;
  const navPos = useMemo(
    () => (sample ? filteredSamples.findIndex(s => s.id === sample.id) : -1),
    [sample, filteredSamples]
  );

  // The right panel always follows the app UI theme. The capture's image
  // theme is independent and applied only to the off-screen capture render
  // (in ChatView), so toggling it no longer re-themes this panel.

  const renderContent = () => {
    if (viewMode === 'evidence') {
      return (
        <EvidenceView
          samples={filteredSamples}
          isDarkMode={isDarkMode}
          annotator={annotator}
          onOpenQuote={onOpenQuote ?? (() => {})}
          onAudit={onAudit ?? (() => {})}
        />
      );
    }
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
        <div className="h-full flex items-center justify-center text-gray-500">
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
          onExitPresentationMode={onExitPresentationMode}
          imageTheme={imageTheme}
          exportWidth={exportWidth}
          fontSize={fontSize}
          onPresentationPreview={onPresentationPreview}
          onPreviewPending={onPreviewPending}
          presentationDrafts={presentationDrafts}
          presentationActiveIndex={presentationActiveIndex}
          onPresentationActiveIndexChange={onPresentationActiveIndexChange}
        />
      );
    }

    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <div className="text-center">
          <span className="material-symbols-outlined" style={{ fontSize: 48 }}>chat</span>
          <p className="mt-2">Select a sample to view the conversation</p>
        </div>
      </div>
    );
  };

  return (
    <div className={`h-full flex flex-col ${isDarkMode ? 'bg-[#0e1114]' : 'bg-[#f6f5f3]'}`}>
      <NavigationBar
        sample={sample}
        experimentName={experimentName}
        navPos={navPos}
        navTotal={navTotal}
        onNavigate={onNavigate}
        isDarkMode={isDarkMode}
        filePath={filePath}
        generateLink={generateLink}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        isSharedMode={isSharedMode}
        highlightedMessageIndex={highlightedMessageIndex}
        highlightedText={highlightedText}
        shareToken={shareToken}
        selectedIndexInFile={selectedIndexInFile}
        isPresentationMode={isPresentationMode}
        onTogglePresentationMode={onTogglePresentationMode}
        isTriageMode={isTriageMode}
        onToggleTriageMode={onToggleTriageMode}
        isRolloutChatOpen={isRolloutChatOpen}
        onToggleRolloutChat={onToggleRolloutChat}
        webChatBaseUrl={webChatBaseUrl}
        isCompanionOpen={isCompanionOpen}
        onToggleCompanions={() => setIsCompanionOpen(v => !v)}
        isCommentsOpen={isCommentsOpen}
        commentCount={commentCount}
        onToggleComments={onAddComment ? onToggleComments : undefined}
        commentsAttention={commentsAttention}
        commentsToggleRef={commentsToggleRef}
      />

      {/* Content + both drawers share a flex row: on sm+ each drawer is a
          static sibling, so opening one SHRINKS the transcript instead of
          covering the text you are reading. `relative` hosts their
          small-screen overlay fallback. */}
      <div className="flex-1 min-h-0 flex relative overflow-hidden">
        <div className="relative flex-1 min-w-0 overflow-hidden">
          {renderContent()}
        </div>
        {isCompanionOpen && filePath && (
          <CompanionDrawer
            filePath={filePath}
            isDarkMode={isDarkMode}
            onClose={() => setIsCompanionOpen(false)}
          />
        )}
        {commentsMounted && onAddComment && (
          <CommentsPanel
            sample={sample}
            isOpen={isCommentsOpen}
            isDarkMode={isDarkMode}
            annotator={annotator}
            onAnnotatorChange={onAnnotatorChange ?? NOOP}
            onAddComment={onAddComment}
            onDeleteComment={onDeleteComment}
            onClose={handleCloseComments}
            onAttentionChange={setCommentsAttention}
          />
        )}
      </div>
    </div>
  );
}
