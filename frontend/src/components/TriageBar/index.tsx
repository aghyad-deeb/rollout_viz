import { useState } from 'react';

export interface TriageBarProps {
  isDarkMode: boolean;
  /** Current annotator name; '' when not yet set. */
  annotator: string;
  onAnnotatorChange: (name: string) => void;
  /** Verdict labels in hotkey order (1-based). Pass-through of TRIAGE_VERDICTS. */
  verdicts: readonly string[];
  /** Latest human verdict for the selected sample, null if unreviewed / no selection. */
  currentVerdict: string | null;
  /** Note (explanation) stored with that verdict, '' if none. */
  currentNote: string;
  /** Draft note lifted to App so the global hotkey handler can attach it. */
  noteDraft: string;
  onNoteDraftChange: (note: string) => void;
  /** Reviewed/total over the CURRENT FILTERED scope. */
  reviewedCount: number;
  totalCount: number;
  /** Count per verdict over the filtered scope, keyed by verdict label. */
  verdictCounts: Record<string, number>;
  hasSelection: boolean;
  /** Records a verdict for the selected sample (App saves + auto-advances). */
  onVerdict: (verdict: string) => void;
  onJumpToUnreviewed: () => void;
  /** Non-null while the last save failed — render inline, prominent. */
  saveError: string | null;
  onClose: () => void;
}

// Filled styles for the button matching currentVerdict, keyed by label.
// Solid fills read fine in both themes; unknown labels fall back to gray.
const SELECTED_VERDICT_CLASSES: Record<string, string> = {
  clean: 'bg-teal-600 border-teal-600 text-white',
  hack: 'bg-red-600 border-red-600 text-white',
  interesting: 'bg-amber-500 border-amber-500 text-white',
  unsure: 'bg-gray-500 border-gray-500 text-white',
};
const SELECTED_VERDICT_FALLBACK = 'bg-gray-500 border-gray-500 text-white';

export function TriageBar({
  isDarkMode,
  annotator,
  onAnnotatorChange,
  verdicts,
  currentVerdict,
  currentNote,
  noteDraft,
  onNoteDraftChange,
  reviewedCount,
  totalCount,
  verdictCounts,
  hasSelection,
  onVerdict,
  onJumpToUnreviewed,
  saveError,
  onClose,
}: TriageBarProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(annotator);

  // Prop-driven reset via in-render key adjustment (no setState in an
  // effect body): when App commits a new annotator, leave edit mode and
  // re-seed the draft with the committed name.
  const [prevAnnotator, setPrevAnnotator] = useState(annotator);
  if (prevAnnotator !== annotator) {
    setPrevAnnotator(annotator);
    setIsEditingName(false);
    setNameDraft(annotator);
  }

  const annotatorSet = annotator !== '';
  const showNameInput = !annotatorSet || isEditingName;

  const submitName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    onAnnotatorChange(trimmed);
    setIsEditingName(false);
  };

  const verdictsDisabled = !annotatorSet || !hasSelection;
  const verdictDisabledReason = !annotatorSet
    ? 'Set your name first — verdicts are tagged with the annotator'
    : !hasSelection
      ? 'Select a rollout to record a verdict'
      : null;

  const progressPct =
    totalCount > 0 ? Math.min(100, (reviewedCount / totalCount) * 100) : 0;
  const allReviewed = reviewedCount >= totalCount;

  const mutedText = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const inputCls = `px-2 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-sky-500 ${
    isDarkMode
      ? 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-500'
      : 'bg-white border-gray-300 text-gray-800 placeholder-gray-400'
  }`;
  const iconBtnCls = `p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed ${
    isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'
  }`;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b text-xs ${
        isDarkMode ? 'bg-sky-950/40 border-sky-900/60' : 'bg-sky-50/80 border-sky-200'
      }`}
    >
      {/* Left: mode label + annotator identity */}
      <span
        className={`inline-flex items-center gap-1 font-medium ${
          isDarkMode ? 'text-sky-300' : 'text-sky-700'
        }`}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">
          checklist
        </span>
        Triage
      </span>

      {showNameInput ? (
        <span className="inline-flex items-center gap-1.5">
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitName();
            }}
            placeholder="Your name (stored locally, tags your verdicts)"
            className={`w-64 ${inputCls}`}
          />
          <button
            type="button"
            onClick={submitName}
            disabled={nameDraft.trim() === ''}
            className={`px-2 py-0.5 rounded text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
              isDarkMode
                ? 'bg-sky-700 text-white hover:bg-sky-600'
                : 'bg-sky-600 text-white hover:bg-sky-700'
            }`}
          >
            Save
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => {
            setNameDraft(annotator);
            setIsEditingName(true);
          }}
          title="Edit annotator name"
          className={`px-1.5 py-0.5 rounded ${mutedText} ${
            isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'
          }`}
        >
          as {annotator}
        </button>
      )}

      {/* Middle: verdict buttons */}
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {verdicts.map((label, i) => {
          const isSelected = currentVerdict === label;
          const kbdCls = `px-1 rounded border font-mono text-[10px] ${
            isSelected
              ? 'border-white/40 bg-white/10 text-white'
              : isDarkMode
                ? 'border-gray-600 bg-gray-800 text-gray-300'
                : 'border-gray-300 bg-white text-gray-700'
          }`;
          return (
            <button
              key={label}
              type="button"
              data-testid={`verdict-${label}`}
              onClick={() => onVerdict(label)}
              disabled={verdictsDisabled}
              aria-pressed={isSelected}
              title={verdictDisabledReason ?? `Mark as ${label} (press ${i + 1})`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs disabled:opacity-50 disabled:cursor-not-allowed ${
                isSelected
                  ? (SELECTED_VERDICT_CLASSES[label] ?? SELECTED_VERDICT_FALLBACK)
                  : isDarkMode
                    ? 'border-gray-600 text-gray-200 hover:bg-gray-700'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-100'
              }`}
            >
              <kbd className={kbdCls}>{i + 1}</kbd>
              {label}
              <span
                className={`font-data text-[10px] ${
                  isSelected ? 'text-white/70' : isDarkMode ? 'text-gray-500' : 'text-gray-400'
                }`}
              >
                {verdictCounts[label] ?? 0}
              </span>
            </button>
          );
        })}
      </span>

      {/* Note draft — the App-side hotkey handler attaches it on save. */}
      <input
        type="text"
        value={noteDraft}
        onChange={(e) => onNoteDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Blur only — don't let Escape bubble up and close modals/modes.
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
        placeholder="note (optional)…"
        className={`w-56 ${inputCls}`}
      />

      {/* Stored note for the already-reviewed selection */}
      {currentVerdict !== null && currentNote !== '' && (
        <span
          title={currentNote}
          className={`max-w-[12rem] truncate px-2 py-0.5 rounded ${
            isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {currentNote}
        </span>
      )}

      {saveError !== null && (
        <span
          role="alert"
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border font-medium ${
            isDarkMode
              ? 'bg-red-900/40 border-red-700 text-red-300'
              : 'bg-red-100 border-red-300 text-red-700'
          }`}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden="true">
            error
          </span>
          {saveError}
        </span>
      )}

      {/* Right: progress + navigation + exit */}
      <span className="ml-auto inline-flex items-center gap-2">
        <span className={`font-data whitespace-nowrap ${mutedText}`}>
          {reviewedCount}/{totalCount} reviewed
        </span>
        <span
          className={`inline-block h-1 w-20 rounded-full overflow-hidden ${
            isDarkMode ? 'bg-gray-700' : 'bg-gray-200'
          }`}
        >
          <span
            data-testid="triage-progress-fill"
            className={`block h-full rounded-full ${isDarkMode ? 'bg-sky-500' : 'bg-sky-600'}`}
            style={{ width: `${progressPct}%` }}
          />
        </span>
        <button
          type="button"
          onClick={onJumpToUnreviewed}
          disabled={allReviewed}
          title="Next unreviewed"
          aria-label="Next unreviewed"
          className={iconBtnCls}
        >
          <span
            className={`material-symbols-outlined text-lg ${mutedText}`}
            aria-hidden="true"
          >
            skip_next
          </span>
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Exit triage mode"
          aria-label="Exit triage mode"
          className={iconBtnCls}
        >
          <span
            className={`material-symbols-outlined text-lg ${mutedText}`}
            aria-hidden="true"
          >
            close
          </span>
        </button>
      </span>
    </div>
  );
}
