import { useEffect, useMemo, useRef, useState } from 'react';
import type { GradeEntry, Sample } from '../../types';
import type { EvidenceItem } from '../../utils/evidence';
import { buildEvidenceIndex, evidenceItemKey, metricsWithGrades } from '../../utils/evidence';
import { formatTimestamp } from '../../utils/formatTimestamp';

// The Evidence view: one scrolling feed of every quote the LLM judge saved
// for one metric across the loaded corpus, flagged where the "evidence"
// can't be verified (no quotes saved / quote text absent from the
// transcript / transcript not loaded yet). Entirely props-driven — all
// corpus logic lives in utils/evidence.ts.

interface EvidenceViewProps {
  samples: Sample[]; // already-filtered scope (App passes filteredSamples)
  isDarkMode: boolean;
  /** '' disables the audit hotkeys/buttons (annotator not set). */
  annotator: string;
  /** Jump into the chat view at this quote (App switches view + highlights). */
  onOpenQuote: (sampleId: number, messageIndex: number | null, highlightText: string | null) => void;
  /** Record a human confirm/dispute for a BOOL metric (App builds+saves the entry and updates state). Return value ignored. */
  onAudit: (sampleId: number, metric: string, action: 'confirm' | 'dispute', judgeEntry: GradeEntry) => void;
}

type ValueFilter = 'all' | 'yes' | 'no';
type FlagFilter = 'all' | 'no_evidence' | 'not_found';

const AUDIT_DISABLED_TITLE = 'Set your name in Triage mode to record audits';
const EXPLANATION_PREVIEW_LEN = 200;
const GRADE_PREVIEW_LEN = 24;

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function formatGradeValue(entry: GradeEntry): string {
  if (entry.grade_type === 'bool') return entry.grade ? '✓ Yes' : '✗ No';
  if (entry.grade_type === 'float' && typeof entry.grade === 'number') {
    return entry.grade.toFixed(2);
  }
  const text = String(entry.grade ?? '').trim();
  if (!text) return '(empty)';
  return text.length <= GRADE_PREVIEW_LEN ? text : text.slice(0, GRADE_PREVIEW_LEN).trimEnd() + '…';
}

// Small segmented control shared by the value and flag filters.
function Segmented({
  label,
  options,
  value,
  onChange,
  isDarkMode,
}: {
  label: string;
  options: { value: string; label: string; title?: string }[];
  value: string;
  onChange: (value: string) => void;
  isDarkMode: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex rounded-md border overflow-hidden ${
        isDarkMode ? 'border-gray-700' : 'border-gray-300'
      }`}
    >
      {options.map(option => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          title={option.title}
          className={`px-2 py-0.5 text-xs whitespace-nowrap transition-colors ${
            value === option.value
              ? isDarkMode
                ? 'bg-gray-700 text-gray-100'
                : 'bg-gray-200 text-gray-800'
              : isDarkMode
                ? 'text-gray-400 hover:bg-gray-800'
                : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// Truncated text block with a Show more toggle (same pattern as the grades
// panel's explanation block).
function TruncatedText({ text, isDarkMode }: { text: string; isDarkMode: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldTruncate = text.length > EXPLANATION_PREVIEW_LEN;
  const displayText =
    shouldTruncate && !isExpanded ? text.slice(0, EXPLANATION_PREVIEW_LEN) + '…' : text;
  return (
    <p className={`text-xs leading-relaxed whitespace-pre-wrap ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
      {displayText}
      {shouldTruncate && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`ml-1 font-medium ${
            isDarkMode ? 'text-purple-400 hover:text-purple-300' : 'text-purple-600 hover:text-purple-500'
          }`}
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </p>
  );
}

export function EvidenceView({ samples, isDarkMode, annotator, onOpenQuote, onAudit }: EvidenceViewProps) {
  const metrics = useMemo(() => metricsWithGrades(samples), [samples]);
  // Default: first metric with any quotes, else first.
  const defaultMetric = useMemo(
    () => (metrics.find(m => m.quoteCount > 0) ?? metrics[0])?.metric ?? '',
    [metrics],
  );
  // null = follow the default; a stale explicit choice (metric no longer
  // graded in the current scope) also falls back — derived, so no effect
  // is needed to keep it valid across sample-scope changes.
  const [metricChoice, setMetricChoice] = useState<string | null>(null);
  const metric =
    metricChoice !== null && metrics.some(m => m.metric === metricChoice)
      ? metricChoice
      : defaultMetric;

  const [valueFilter, setValueFilter] = useState<ValueFilter>('all');
  const [flagFilter, setFlagFilter] = useState<FlagFilter>('all');
  const [activeIdx, setActiveIdx] = useState(0);
  // Optimistic per-card "recorded ✓" marks — App owns the real state.
  const [recordedKeys, setRecordedKeys] = useState<ReadonlySet<string>>(() => new Set());

  // Reset cursor + local audit marks when the sample scope changes identity
  // (filter change upstream). In-render key adjustment, not setState-in-effect.
  const [samplesKey, setSamplesKey] = useState(samples);
  if (samplesKey !== samples) {
    setSamplesKey(samples);
    setActiveIdx(0);
    setRecordedKeys(new Set());
  }

  const items = useMemo(
    () => (metric ? buildEvidenceIndex(samples, metric) : []),
    [samples, metric],
  );
  const isBoolMetric = items.length > 0 && items.every(i => i.entry.grade_type === 'bool');

  const visibleItems = useMemo(
    () =>
      items.filter(item => {
        if (valueFilter !== 'all') {
          if (item.entry.grade_type !== 'bool') return false;
          if (valueFilter === 'yes' && !item.entry.grade) return false;
          if (valueFilter === 'no' && item.entry.grade) return false;
        }
        if (flagFilter === 'no_evidence' && !item.noEvidence) return false;
        if (flagFilter === 'not_found' && !item.quoteNotFound) return false;
        return true;
      }),
    [items, valueFilter, flagFilter],
  );

  const rolloutCount = useMemo(
    () => new Set(visibleItems.map(item => item.sampleId)).size,
    [visibleItems],
  );

  // Cursor clamped to the current feed length (filters can shrink it).
  const activeIndex = visibleItems.length === 0 ? -1 : Math.min(activeIdx, visibleItems.length - 1);

  // Unstable callback props read inside the keydown effect go through refs
  // synced by their own effects (identity discipline).
  const onOpenQuoteRef = useRef(onOpenQuote);
  useEffect(() => {
    onOpenQuoteRef.current = onOpenQuote;
  }, [onOpenQuote]);
  const onAuditRef = useRef(onAudit);
  useEffect(() => {
    onAuditRef.current = onAudit;
  }, [onAudit]);

  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  // J/K move the active-card cursor, Enter opens the active card in chat,
  // Y/X confirm/dispute (bool metrics, annotator set). Standard typing guard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();

      if (k === 'j' || k === 'k') {
        if (visibleItems.length === 0) return;
        e.preventDefault();
        const next = k === 'j'
          ? Math.min(activeIndex + 1, visibleItems.length - 1)
          : Math.max(activeIndex - 1, 0);
        setActiveIdx(next);
        // Optional call guards jsdom (no scrollIntoView there).
        cardRefs.current[next]?.scrollIntoView?.({ block: 'nearest' });
        return;
      }

      const item = activeIndex >= 0 ? visibleItems[activeIndex] : undefined;
      if (!item) return;

      if (k === 'enter') {
        e.preventDefault();
        onOpenQuoteRef.current(item.sampleId, item.quote?.message_index ?? null, item.quote?.text ?? null);
        return;
      }
      if ((k === 'y' || k === 'x') && annotator !== '' && item.entry.grade_type === 'bool') {
        const key = evidenceItemKey(item);
        if (recordedKeys.has(key)) return;
        e.preventDefault();
        onAuditRef.current(item.sampleId, metric, k === 'y' ? 'confirm' : 'dispute', item.entry);
        setRecordedKeys(prev => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleItems, activeIndex, annotator, metric, recordedKeys]);

  const mutedText = isDarkMode ? 'text-gray-500' : 'text-gray-400';

  // Empty state: nothing graded anywhere in the current scope.
  if (metrics.length === 0) {
    return (
      <div className={`h-full flex flex-col items-center justify-center gap-2 p-8 text-center ${
        isDarkMode ? 'text-gray-400' : 'text-gray-500'
      }`}>
        <span className={`material-symbols-outlined ${isDarkMode ? 'text-purple-400' : 'text-purple-500'}`} style={{ fontSize: 40 }} aria-hidden="true">
          format_quote
        </span>
        <p className="text-sm font-medium">No graded metrics yet</p>
        <p className={`text-xs ${mutedText}`}>
          Run an LLM grading job, then browse every saved quote here.
        </p>
      </div>
    );
  }

  const handleAuditClick = (item: EvidenceItem, action: 'confirm' | 'dispute') => {
    if (annotator === '' || item.entry.grade_type !== 'bool') return;
    onAudit(item.sampleId, metric, action, item.entry);
    const key = evidenceItemKey(item);
    setRecordedKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const chipBase = 'inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded whitespace-nowrap';
  const footerButtonBase = `inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed`;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header: metric picker + filters + summary */}
      <div className={`shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b ${
        isDarkMode ? 'border-gray-700' : 'border-gray-200'
      }`}>
        <span className={`material-symbols-outlined ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`} style={{ fontSize: 18 }} aria-hidden="true">
          format_quote
        </span>
        <select
          aria-label="Evidence metric"
          value={metric}
          onChange={e => setMetricChoice(e.target.value)}
          className={`text-xs rounded-md border px-2 py-1 max-w-[24rem] ${
            isDarkMode
              ? 'bg-gray-800 border-gray-700 text-gray-200'
              : 'bg-white border-gray-300 text-gray-700'
          }`}
        >
          {metrics.map(m => (
            <option key={m.metric} value={m.metric}>
              {`${m.metric} — ${m.gradedCount} graded · ${m.quoteCount} quotes`}
            </option>
          ))}
        </select>
        {isBoolMetric && (
          <Segmented
            label="Filter by grade value"
            isDarkMode={isDarkMode}
            value={valueFilter}
            onChange={v => setValueFilter(v as ValueFilter)}
            options={[
              { value: 'all', label: 'All', title: 'All grade values' },
              { value: 'yes', label: '✓', title: 'Only ✓ Yes grades' },
              { value: 'no', label: '✗', title: 'Only ✗ No grades' },
            ]}
          />
        )}
        <Segmented
          label="Filter by flags"
          isDarkMode={isDarkMode}
          value={flagFilter}
          onChange={v => setFlagFilter(v as FlagFilter)}
          options={[
            { value: 'all', label: 'All', title: 'All evidence items' },
            { value: 'no_evidence', label: 'no evidence', title: 'Entries that saved no quotes' },
            { value: 'not_found', label: 'quote not found', title: 'Quotes absent from the transcript' },
          ]}
        />
        <span className={`text-xs ml-auto ${mutedText}`}>
          {visibleItems.length} evidence items across {rolloutCount} rollouts
        </span>
      </div>

      {/* Feed */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
        {visibleItems.length === 0 ? (
          <div className={`text-center py-12 text-sm italic ${mutedText}`}>
            No matching evidence for the current filters.
          </div>
        ) : (
          <div className="mx-auto max-w-[52rem] flex flex-col gap-3">
            {visibleItems.map((item, idx) => {
              const key = evidenceItemKey(item);
              const isActive = idx === activeIndex;
              const isRecorded = recordedKeys.has(key);
              const timestamp = item.entry.timestamp
                ? (formatTimestamp(item.entry.timestamp) ?? item.entry.timestamp)
                : null;
              const auditDisabled = annotator === '';
              return (
                <div
                  key={`${key}#${idx}`}
                  ref={el => {
                    cardRefs.current[idx] = el;
                  }}
                  data-testid="evidence-card"
                  onClick={() => setActiveIdx(idx)}
                  className={`rounded-lg border p-3 shadow-sm ${
                    isDarkMode ? 'border-gray-700 bg-gray-800/60' : 'border-gray-200 bg-white'
                  } ${
                    isActive
                      ? (isDarkMode ? 'ring-2 ring-blue-400/70' : 'ring-2 ring-blue-500/60')
                      : ''
                  }`}
                >
                  {/* Header line */}
                  <div className="flex flex-wrap items-center gap-2 min-w-0 mb-2">
                    <span className={`text-sm font-medium shrink-0 ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
                      Rollout {item.rolloutN}
                    </span>
                    {item.sourceFile && (
                      <span
                        className={`text-xs truncate max-w-[16ch] ${mutedText}`}
                        title={item.sourceFile}
                      >
                        {basename(item.sourceFile)}
                      </span>
                    )}
                    <span
                      className={`text-xs font-data ${
                        item.reward >= 0
                          ? (isDarkMode ? 'text-teal-400' : 'text-teal-700')
                          : (isDarkMode ? 'text-red-400' : 'text-red-600')
                      }`}
                      title={`reward ${item.reward}`}
                    >
                      {item.reward.toFixed(2)}
                    </span>
                    <span
                      className={`${chipBase} ${
                        item.entry.grade_type === 'bool'
                          ? item.entry.grade
                            ? (isDarkMode ? 'bg-teal-500/15 text-teal-300' : 'bg-teal-100 text-teal-800')
                            : (isDarkMode ? 'bg-red-500/15 text-red-300' : 'bg-red-100 text-red-700')
                          : (isDarkMode ? 'bg-gray-700 text-gray-200' : 'bg-gray-100 text-gray-700')
                      } ${item.entry.grade_type === 'float' || item.entry.grade_type === 'int' ? 'font-data' : ''}`}
                      title={`${metric}: ${formatGradeValue(item.entry)}`}
                    >
                      {formatGradeValue(item.entry)}
                    </span>
                    {item.noEvidence && (
                      <span className={`${chipBase} ${isDarkMode ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>
                        no evidence saved
                      </span>
                    )}
                    {item.quoteNotFound && (
                      <span className={`${chipBase} ${isDarkMode ? 'bg-red-500/15 text-red-300' : 'bg-red-100 text-red-700'}`}>
                        quote not found in transcript
                      </span>
                    )}
                    {item.transcriptUnloaded && (
                      <span className={`${chipBase} ${isDarkMode ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
                        transcript not loaded
                      </span>
                    )}
                  </div>

                  {/* Body */}
                  {item.context && (
                    <div className={`whitespace-pre-wrap text-sm leading-relaxed rounded p-2 mb-2 ${
                      isDarkMode ? 'bg-gray-900/40 text-gray-300' : 'bg-gray-50 text-gray-700'
                    }`}>
                      {item.context.before}
                      <mark className={`border-b-2 border-purple-400 ${
                        isDarkMode ? 'bg-purple-900/50 text-purple-200' : 'bg-purple-200 text-purple-900'
                      }`}>
                        {item.context.match}
                      </mark>
                      {item.context.after}
                    </div>
                  )}
                  {item.quoteNotFound && item.quote && (
                    <div className={`text-sm rounded p-2 mb-2 border ${
                      isDarkMode ? 'bg-red-500/10 border-red-500/30' : 'bg-red-50 border-red-200'
                    }`}>
                      <div className={`text-xs font-medium mb-1 ${isDarkMode ? 'text-red-300' : 'text-red-700'}`}>
                        judge quoted:
                      </div>
                      <p className={`whitespace-pre-wrap text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        {item.quote.text}
                      </p>
                    </div>
                  )}
                  {item.transcriptUnloaded && item.quote && (
                    <div className={`text-sm rounded p-2 mb-2 border ${
                      isDarkMode ? 'bg-gray-900/40 border-gray-700' : 'bg-gray-50 border-gray-200'
                    }`}>
                      <div className={`text-xs font-medium mb-1 ${mutedText}`}>
                        judge quoted:
                      </div>
                      <p className={`whitespace-pre-wrap text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        {item.quote.text}
                      </p>
                    </div>
                  )}
                  {item.noEvidence && (
                    <p className={`italic text-sm mb-2 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      The judge saved no supporting quotes.
                    </p>
                  )}
                  {item.entry.explanation && (
                    <TruncatedText text={item.entry.explanation} isDarkMode={isDarkMode} />
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-between gap-2 mt-2">
                    <span className={`text-xs truncate ${mutedText}`}>
                      {item.entry.model}
                      {timestamp ? ` • ${timestamp}` : ''}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => onOpenQuote(item.sampleId, item.quote?.message_index ?? null, item.quote?.text ?? null)}
                        title="Open this rollout in the chat view (Enter)"
                        className={`${footerButtonBase} ${
                          isDarkMode
                            ? 'border-gray-700 text-gray-300 hover:bg-gray-700'
                            : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden="true">
                          open_in_new
                        </span>
                        Open in chat
                      </button>
                      {item.entry.grade_type === 'bool' && (
                        isRecorded ? (
                          <span className={`text-xs px-2 py-1 font-medium ${isDarkMode ? 'text-teal-400' : 'text-teal-700'}`}>
                            recorded ✓
                          </span>
                        ) : (
                          <>
                            <button
                              onClick={() => handleAuditClick(item, 'confirm')}
                              disabled={auditDisabled}
                              title={auditDisabled ? AUDIT_DISABLED_TITLE : "Confirm the judge's grade (Y)"}
                              className={`${footerButtonBase} ${
                                isDarkMode
                                  ? 'border-teal-500/40 text-teal-300 hover:bg-teal-500/10'
                                  : 'border-teal-600/40 text-teal-700 hover:bg-teal-50'
                              }`}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden="true">
                                check
                              </span>
                              Confirm
                            </button>
                            <button
                              onClick={() => handleAuditClick(item, 'dispute')}
                              disabled={auditDisabled}
                              title={auditDisabled ? AUDIT_DISABLED_TITLE : "Dispute the judge's grade (X)"}
                              className={`${footerButtonBase} ${
                                isDarkMode
                                  ? 'border-red-500/40 text-red-300 hover:bg-red-500/10'
                                  : 'border-red-400/60 text-red-600 hover:bg-red-50'
                              }`}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden="true">
                                close
                              </span>
                              Dispute
                            </button>
                          </>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
