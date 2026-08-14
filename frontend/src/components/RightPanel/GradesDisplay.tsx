import { useState, useMemo, useRef, useEffect } from 'react';
import type { SampleGrades, GradeEntry, Quote } from '../../types';
import { formatTimestamp } from '../../utils/formatTimestamp';
import { COMMENTS_METRIC, latestJudgeEntry } from '../../utils/humanGrades';

// Component for truncated text blocks (shared by explanations and freeform answers).
function ExplanationText({
  explanation,
  isDarkMode,
  label = 'Explanation:',
}: {
  explanation: string;
  isDarkMode: boolean;
  label?: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const maxLength = 150;
  const shouldTruncate = explanation.length > maxLength;

  // Bring the newly revealed text into view inside the scrollable grades
  // pane. Runs as an effect keyed on isExpanded (not inline in the click
  // handler) so it fires after the full text has actually rendered. The
  // optional call guards jsdom, which has no scrollIntoView.
  useEffect(() => {
    if (isExpanded) textRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [isExpanded]);

  const displayText = shouldTruncate && !isExpanded
    ? explanation.slice(0, maxLength) + '...'
    : explanation;

  return (
    <div className={`text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
      <div className={`text-xs font-medium mb-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
        {label}
      </div>
      <p ref={textRef} className="whitespace-pre-wrap text-xs leading-relaxed">
        {displayText}
        {shouldTruncate && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`ml-1 font-medium ${isDarkMode ? 'text-purple-400 hover:text-purple-300' : 'text-purple-600 hover:text-purple-500'}`}
          >
            {isExpanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </p>
    </div>
  );
}

interface GradesDisplayProps {
  grades: SampleGrades | undefined;
  selectedMetric: string | undefined;
  onSelectMetric: (metric: string | undefined) => void;
  // `quoteIdx` is the position of the quote in `selectedQuotes` (sorted by
  // message_index then start). Consumers use it to target the Nth rendered
  // purple mark rather than just the message it lives in.
  onScrollToQuote?: (messageIndex: number, quoteIdx: number) => void;
  isDarkMode: boolean;
  currentQuoteIndex?: number;
  onQuoteIndexChange?: (index: number) => void;
}

// Short label for chips; freeform grades get truncated since a grade can be
// an entire paragraph of prose.
const FREEFORM_PREVIEW_LEN = 24;

function formatGrade(grade: number | boolean | string, gradeType: string): string {
  if (gradeType === 'bool') return grade ? '✓ Yes' : '✗ No';
  if (gradeType === 'float') return (grade as number).toFixed(2);
  if (gradeType === 'freeform') {
    const text = String(grade ?? '').trim();
    if (text.length <= FREEFORM_PREVIEW_LEN) return text || '(empty)';
    return text.slice(0, FREEFORM_PREVIEW_LEN).trimEnd() + '…';
  }
  if (gradeType === 'categorical') {
    // The chosen category name — short by design; show it (lightly capped).
    const text = String(grade ?? '').trim();
    if (!text) return '(none)';
    return text.length <= 32 ? text : text.slice(0, 32).trimEnd() + '…';
  }
  return String(grade);
}

// Positive grades render in the app's teal identity (#2a9d8f family — the
// same hue the Analysis charts use for positive reward), not raw green.
function getGradeColor(grade: number | boolean | string, gradeType: string, isDarkMode: boolean): string {
  if (gradeType === 'bool') {
    return grade
      ? (isDarkMode ? 'text-teal-400' : 'text-teal-700')
      : (isDarkMode ? 'text-red-400' : 'text-red-600');
  }
  if (gradeType === 'freeform') {
    // Freeform grades aren't good/bad — neutral color.
    return isDarkMode ? 'text-gray-200' : 'text-gray-700';
  }
  if (gradeType === 'categorical') {
    // Categories have no intrinsic good/bad ordering — render as a neutral
    // label color (distinct from freeform gray so it reads as a value).
    return isDarkMode ? 'text-sky-400' : 'text-sky-700';
  }
  if (gradeType === 'int') {
    // Int grades have no fixed scale — the float 0-1 thresholds below would
    // paint any value >= 1 green. Render as a neutral value color instead.
    return isDarkMode ? 'text-gray-200' : 'text-gray-700';
  }
  const value = grade as number;
  if (value >= 0.7) return isDarkMode ? 'text-teal-400' : 'text-teal-700';
  if (value >= 0.4) return isDarkMode ? 'text-yellow-400' : 'text-yellow-600';
  return isDarkMode ? 'text-red-400' : 'text-red-600';
}

// One row per metric with its latest entry pre-resolved — the unit both the
// chip grid and the header summary render from.
interface MetricRow {
  metric: string;
  list: GradeEntry[];
  latest: GradeEntry;
}

const sortQuotes = (quotes: Quote[]): Quote[] =>
  [...quotes].sort((a, b) => {
    if (a.message_index !== b.message_index) return a.message_index - b.message_index;
    return a.start - b.start;
  });

export function GradesDisplay({
  grades,
  selectedMetric,
  onSelectMetric,
  onScrollToQuote,
  isDarkMode,
  currentQuoteIndex = 0,
  onQuoteIndexChange,
}: GradesDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  // Which run is displayed per metric (index into that metric's grade list).
  // Missing key = latest run. Reset whenever the grades prop changes so a new
  // sample (or a fresh grading run) always opens on the latest entry. Done as
  // an in-render state adjustment (same pattern as LeftPanel's shuffle reset)
  // rather than an effect, so there's no extra commit with stale indices.
  const [historyIndex, setHistoryIndex] = useState<Record<string, number>>({});
  const [historyGradesKey, setHistoryGradesKey] = useState(grades);
  if (historyGradesKey !== grades) {
    setHistoryGradesKey(grades);
    setHistoryIndex({});
  }

  // `comments` is a reserved human-annotation metric, not a judgement: it
  // rides the grade rails for storage only and belongs in the comments
  // drawer, never in the judge strip above the transcript.
  const rows = useMemo<MetricRow[]>(() =>
    Object.entries(grades ?? {})
      .filter(([metric]) => metric !== COMMENTS_METRIC)
      .map(([metric, list]) => ({ metric, list, latest: list[list.length - 1] }))
      .filter((r): r is MetricRow => Boolean(r.latest)),
    [grades],
  );

  // Bring the detail card into view inside the scrollable pane when a chip
  // is selected — with many chips the card can otherwise open below the
  // pane's fold. (Optional call guards jsdom.)
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedMetric) detailRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedMetric]);

  // Header summary: failing bool metrics are the signal — they get named
  // chips; passing bools compress into one aggregate; non-bool metrics get
  // named value chips in the remaining slots.
  const summary = useMemo(() => {
    const bools = rows.filter(r => r.latest.grade_type === 'bool');
    const failing = bools.filter(r => !r.latest.grade);
    const passing = bools.length - failing.length;
    const other = rows.filter(r => r.latest.grade_type !== 'bool');
    return { bools, failing, passing, other };
  }, [rows]);

  // Get sorted quotes for the selected metric — always from the latest
  // JUDGE run: human confirm/dispute entries append to the same list but
  // carry no quotes, and must not blank the judge's evidence.
  const selectedQuotes = useMemo(() => {
    if (!selectedMetric || !grades?.[selectedMetric]) return [];
    const judge = latestJudgeEntry(grades[selectedMetric]);
    if (!judge?.quotes) return [];
    return sortQuotes(judge.quotes);
  }, [grades, selectedMetric]);

  if (rows.length === 0) {
    return null;
  }

  const selectedRow = selectedMetric ? rows.find(r => r.metric === selectedMetric) : undefined;

  // Toggle a metric: selecting shows its detail card and highlights its
  // quotes in the chat; selecting again (or the ✕) deselects both.
  const toggleMetric = (row: MetricRow) => {
    if (selectedMetric === row.metric) {
      onSelectMetric(undefined);
      return;
    }
    onSelectMetric(row.metric);
    onQuoteIndexChange?.(0);
    const quoteList = latestJudgeEntry(row.list)?.quotes ?? [];
    if (quoteList.length > 0 && onScrollToQuote) {
      const sorted = sortQuotes(quoteList);
      onScrollToQuote(sorted[0].message_index, 0);
    }
  };

  const chipBase = 'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full whitespace-nowrap';
  const headerChipTone = isDarkMode ? 'bg-gray-700' : 'bg-gray-100';

  // Grid-chip tone by outcome: failures pop (tinted fill), passes recede
  // (faint tint), neutral types stay quiet; the selected chip carries the
  // grader-purple used by quote highlights everywhere else.
  const gridChipTone = (latest: GradeEntry, isSel: boolean): string => {
    if (isSel) {
      return isDarkMode
        ? 'border-purple-400/70 bg-purple-500/15 ring-1 ring-purple-400/40 text-gray-100 shadow-sm'
        : 'border-purple-400 bg-purple-50 ring-1 ring-purple-300/60 text-gray-800 shadow-sm';
    }
    if (latest.grade_type === 'bool') {
      return latest.grade
        ? (isDarkMode
          ? 'border-teal-500/25 bg-teal-500/[0.06] hover:border-teal-400/60 text-gray-300'
          : 'border-teal-600/30 bg-teal-50/70 hover:border-teal-600/70 text-gray-600')
        : (isDarkMode
          ? 'border-red-500/45 bg-red-500/10 hover:border-red-400/80 text-gray-200'
          : 'border-red-400/60 bg-red-50 hover:border-red-400 text-gray-700');
    }
    return isDarkMode
      ? 'border-gray-700 bg-gray-800/60 hover:border-gray-500 text-gray-300'
      : 'border-gray-200 bg-white hover:border-gray-400 text-gray-600';
  };

  // Numeric values read as instrument readouts — same tabular mono the
  // Analysis view uses.
  const valueFont = (gradeType: string) =>
    gradeType === 'float' || gradeType === 'int' ? 'font-data' : '';

  // Collapsed-header preview: up to 2 named failing chips (+ a red overflow
  // count), one green pass aggregate, then named non-bool chips in whatever
  // slots remain, and a muted +N for the rest.
  const failingShown = summary.failing.slice(0, 2);
  const extraFailing = summary.failing.length - failingShown.length;
  const otherSlots = Math.max(0, 3 - failingShown.length - (extraFailing > 0 ? 1 : 0) - (summary.passing > 0 ? 1 : 0));
  const otherShown = summary.other.slice(0, otherSlots);
  const remainingCount = summary.other.length - otherShown.length;

  return (
    <div className={`border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className={`w-full flex items-center justify-between px-4 py-2 transition-colors ${
          isDarkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`material-symbols-outlined shrink-0 ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`} style={{ fontSize: 18 }} aria-hidden="true">
            grade
          </span>
          <span className={`text-sm font-medium shrink-0 ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
            LLM Grades
          </span>
          <span className={`text-xs shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {rows.length} metric{rows.length !== 1 ? 's' : ''}
          </span>
          {/* Summary chips — failures lead, passes aggregate. Shown only
              while collapsed: expanded, the grid below is the single
              statement of the same information. Clipped (not wrapped) at
              narrow widths so the header stays one line. */}
          {!isExpanded && (
            <div className="flex items-center gap-1.5 ml-1 min-w-0 overflow-hidden">
              {failingShown.map(r => (
                <span
                  key={r.metric}
                  className={`${chipBase} ${isDarkMode ? 'bg-red-500/15 text-red-300' : 'bg-red-100 text-red-700'}`}
                  title={`${r.metric}: ✗ No`}
                >
                  <span aria-hidden="true">✗</span>
                  <span className="max-w-[16ch] truncate">{r.metric}</span>
                </span>
              ))}
              {extraFailing > 0 && (
                <span className={`${chipBase} font-data ${isDarkMode ? 'bg-red-500/15 text-red-300' : 'bg-red-100 text-red-700'}`}
                  title={summary.failing.slice(2).map(r => r.metric).join(', ')}
                >
                  +{extraFailing} ✗
                </span>
              )}
              {summary.passing > 0 && (
                <span
                  className={`${chipBase} font-data ${isDarkMode ? 'bg-teal-500/15 text-teal-300' : 'bg-teal-100 text-teal-800'}`}
                  title={`${summary.passing} of ${summary.bools.length} boolean metric${summary.bools.length !== 1 ? 's' : ''} passed`}
                >
                  {summary.passing} ✓
                </span>
              )}
              {otherShown.map(r => (
                <span
                  key={r.metric}
                  className={`${chipBase} ${headerChipTone}`}
                  title={`${r.metric}: ${formatGrade(r.latest.grade, r.latest.grade_type)}`}
                >
                  <span className={`max-w-[14ch] truncate ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{r.metric}</span>
                  {r.latest.grade_type === 'freeform' ? (
                    <span className="material-symbols-outlined" style={{ fontSize: 12 }} aria-hidden="true">notes</span>
                  ) : (
                    <span className={`${valueFont(r.latest.grade_type)} ${getGradeColor(r.latest.grade, r.latest.grade_type, isDarkMode)}`}>
                      {formatGrade(r.latest.grade, r.latest.grade_type)}
                    </span>
                  )}
                </span>
              ))}
              {remainingCount > 0 && (
                <span className={`text-xs whitespace-nowrap ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  +{remainingCount} more
                </span>
              )}
            </div>
          )}
        </div>
        <span
          className={`material-symbols-outlined shrink-0 transition-transform duration-200 ${
            isDarkMode ? 'text-gray-400' : 'text-gray-500'
          } ${isExpanded ? '' : '-rotate-90'}`}
          style={{ fontSize: 18 }}
          aria-hidden="true"
        >
          expand_less
        </span>
      </button>

      {/* Expanded content — a scannable chip grid; clicking a chip opens one
          detail card below it (and highlights that metric's quotes in the
          chat). Replaces the old stack of full cards, which made 10+ metrics
          unreadable. */}
      {isExpanded && (
        <div className={`px-4 pb-2 max-h-[40vh] overflow-y-auto custom-scrollbar ${isDarkMode ? 'bg-gray-900/30' : 'bg-gray-100/60'}`}>
          <div className="flex flex-wrap gap-1.5 pt-1.5 pb-2">
            {rows.map(row => {
              const { metric, list, latest } = row;
              const isSel = selectedMetric === metric;
              const judgeQuoteCount = latestJudgeEntry(list)?.quotes?.length ?? 0;
              const hasQuotes = judgeQuoteCount > 0;
              return (
                <button
                  key={metric}
                  onClick={() => toggleMetric(row)}
                  aria-pressed={isSel}
                  title={`${metric}: ${formatGrade(latest.grade, latest.grade_type)}${hasQuotes ? ` · ${judgeQuoteCount} quote${judgeQuoteCount !== 1 ? 's' : ''}` : ''} — click for details${hasQuotes ? ' and quote highlights' : ''}`}
                  className={`inline-flex items-center gap-1.5 text-xs pl-2 pr-1.5 py-1 rounded-md border whitespace-nowrap transition-all duration-150 hover:-translate-y-px ${gridChipTone(latest, isSel)}`}
                >
                  <span className="max-w-[20ch] truncate font-medium">{metric}</span>
                  {/* Bool chips carry their verdict in the tint — a lone
                      glyph keeps 14 chips scannable; the full "✓ Yes" lives
                      in the tooltip and detail card. Passes are muted so
                      failures alone carry bold + full saturation. */}
                  {(() => {
                    const isPassBool = latest.grade_type === 'bool' && Boolean(latest.grade);
                    const valueColor = isPassBool
                      ? (isDarkMode ? 'text-teal-400/70' : 'text-teal-700/80')
                      : getGradeColor(latest.grade, latest.grade_type, isDarkMode);
                    return (
                      <span className={`${isPassBool ? 'font-medium' : 'font-semibold'} max-w-[16ch] truncate ${valueFont(latest.grade_type)} ${valueColor}`}>
                        {latest.grade_type === 'bool'
                          ? (latest.grade ? '✓' : '✗')
                          : latest.grade_type === 'freeform' ? '¶' : formatGrade(latest.grade, latest.grade_type)}
                      </span>
                    );
                  })()}
                  {hasQuotes && (
                    <span
                      // Quiet on idle chips — full-strength purple stays
                      // reserved for the selection ring and detail rail.
                      className={`material-symbols-outlined ${
                        isSel
                          ? (isDarkMode ? 'text-purple-400' : 'text-purple-500')
                          : (isDarkMode ? 'text-purple-400/50' : 'text-purple-500/50')
                      }`}
                      style={{ fontSize: 12 }}
                      aria-hidden="true"
                    >
                      format_quote
                    </span>
                  )}
                  {list.length > 1 && (
                    <span
                      className={`text-[10px] leading-4 px-1 rounded-full font-data ${isDarkMode ? 'bg-white/10 text-gray-400' : 'bg-black/5 text-gray-500'}`}
                      title={`${list.length} grading runs`}
                    >
                      ×{list.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Detail card for the selected metric */}
          {selectedRow && (() => {
            const { metric, list, latest } = selectedRow;
            const runIndex = historyIndex[metric] ?? list.length - 1;
            const entry = list[runIndex] ?? latest;
            const isLatestRun = entry === latest;
            const runTimestamp = entry.timestamp
              ? (formatTimestamp(entry.timestamp) ?? entry.timestamp)
              : null;
            const quoteCount = latestJudgeEntry(list)?.quotes?.length ?? 0;
            const hasQuotes = quoteCount > 0;

            return (
              <div
                ref={detailRef}
                // `analysis-rise` is the app's shared entrance animation
                // (defined in index.css with a reduced-motion guard); the
                // purple rail matches the grade-quote highlight color.
                className={`analysis-rise rounded-lg border border-l-4 p-2.5 shadow-sm ${
                  isDarkMode
                    ? 'border-purple-500/30 border-l-purple-400 bg-purple-500/[0.07]'
                    : 'border-purple-200 border-l-purple-400 bg-purple-50/40'
                }`}
              >
                {/* Header row: name + value + run history + close */}
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-sm font-medium truncate ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`} title={metric}>
                      {metric}
                    </span>
                    {entry.grade_type !== 'freeform' && (
                      <span className={`text-sm font-bold shrink-0 ${valueFont(entry.grade_type)} ${getGradeColor(entry.grade, entry.grade_type, isDarkMode)}`}>
                        {formatGrade(entry.grade, entry.grade_type)}
                      </span>
                    )}
                    {entry.grade_type === 'freeform' && (
                      <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${isDarkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                        freeform
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Run history — grades append per run; page through them. */}
                    {list.length > 1 && (
                      <div className={`flex items-center gap-1 text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        <button
                          onClick={() => setHistoryIndex(prev => ({ ...prev, [metric]: Math.max(0, runIndex - 1) }))}
                          disabled={runIndex <= 0}
                          className={`p-0.5 rounded transition-colors disabled:opacity-40 ${
                            isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
                          }`}
                          title="Previous run"
                          aria-label="Previous run"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">chevron_left</span>
                        </button>
                        <span className="whitespace-nowrap">run {runIndex + 1} of {list.length}</span>
                        <button
                          onClick={() => setHistoryIndex(prev => ({ ...prev, [metric]: Math.min(list.length - 1, runIndex + 1) }))}
                          disabled={runIndex >= list.length - 1}
                          className={`p-0.5 rounded transition-colors disabled:opacity-40 ${
                            isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
                          }`}
                          title="Next run"
                          aria-label="Next run"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">chevron_right</span>
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => onSelectMetric(undefined)}
                      className={`p-0.5 rounded ${isDarkMode ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-200'}`}
                      title="Close details and hide quote highlights"
                      aria-label="Close grade details"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">close</span>
                    </button>
                  </div>
                </div>

                {/* Freeform answer — primary content for this grade type. */}
                {entry.grade_type === 'freeform' && (
                  <div className={`rounded p-2 mb-1 border ${isDarkMode ? 'bg-gray-900/40 border-gray-700' : 'bg-gray-50/80 border-gray-200'}`}>
                    <ExplanationText
                      explanation={String(entry.grade ?? '') || '(empty)'}
                      isDarkMode={isDarkMode}
                      label="Answer:"
                    />
                  </div>
                )}

                {/* Explanation - truncated with expand option */}
                {entry.explanation && (
                  <ExplanationText
                    explanation={entry.explanation}
                    isDarkMode={isDarkMode}
                  />
                )}

                {/* Quotes navigation and model info */}
                <div className={`flex items-center justify-between gap-2 mt-1 text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  <span className="truncate">
                    {hasQuotes && (
                      <>
                        <span className="material-symbols-outlined mr-0.5" style={{ fontSize: 12, verticalAlign: 'middle' }} aria-hidden="true">
                          format_quote
                        </span>
                        {quoteCount} quote{quoteCount !== 1 ? 's' : ''} highlighted
                        {' • '}
                      </>
                    )}
                    {entry.model}
                    {runTimestamp ? ` • ${runTimestamp}` : ''}
                  </span>

                  {/* Quotes always come from the latest run — flag that while
                      browsing an older one instead of highlighting the wrong
                      spans. */}
                  {hasQuotes && !isLatestRun && (
                    <span className="whitespace-nowrap italic">quotes are from the latest run</span>
                  )}
                  {hasQuotes && isLatestRun && selectedQuotes.length > 1 && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const newIndex = currentQuoteIndex <= 0 ? selectedQuotes.length - 1 : currentQuoteIndex - 1;
                          onQuoteIndexChange?.(newIndex);
                          if (onScrollToQuote && selectedQuotes[newIndex]) {
                            onScrollToQuote(selectedQuotes[newIndex].message_index, newIndex);
                          }
                        }}
                        className={`p-0.5 rounded transition-colors ${
                          isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
                        }`}
                        title="Previous quote"
                        aria-label="Previous quote"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">chevron_left</span>
                      </button>
                      <span className={`min-w-[3rem] text-center font-data ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>
                        {currentQuoteIndex + 1}/{selectedQuotes.length}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const newIndex = currentQuoteIndex >= selectedQuotes.length - 1 ? 0 : currentQuoteIndex + 1;
                          onQuoteIndexChange?.(newIndex);
                          if (onScrollToQuote && selectedQuotes[newIndex]) {
                            onScrollToQuote(selectedQuotes[newIndex].message_index, newIndex);
                          }
                        }}
                        className={`p-0.5 rounded transition-colors ${
                          isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
                        }`}
                        title="Next quote"
                        aria-label="Next quote"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">chevron_right</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Nudge when nothing is selected */}
          {!selectedRow && (
            <div className={`text-[11px] italic pb-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              Click a metric for its explanation{rows.some(r => (latestJudgeEntry(r.list)?.quotes?.length ?? 0) > 0) ? ' and quote highlights' : ''}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
