import { useRef, useEffect, useState, useMemo } from 'react';
import type { Sample, SortColumn, SortOrder } from '../../types';
import { COMMENTS_METRIC, authorOf, visibleComments } from '../../utils/humanGrades';

interface SampleTableProps {
  samples: Sample[];
  selectedSampleId: number | null;
  onSelectSample: (id: number) => void;
  sortColumn: SortColumn;
  sortOrder: SortOrder;
  onSort: (column: SortColumn) => void;
  isDarkMode: boolean;
  /**
   * Which attribute the first (identity) column shows. LeftPanel passes
   * 'rollout_n' when every sample shares one sample_index (a degenerate ID
   * column) but rollout_n varies; defaults to 'sample_index'.
   */
  idColumnKey?: 'sample_index' | 'rollout_n';
  /**
   * Column keys to omit (step/reward/data_source). LeftPanel computes these
   * for constant-at-default columns; identity and metric columns are never
   * hidden regardless of the set's contents.
   */
  hiddenColumns?: ReadonlySet<string>;
}

// Hoisted default — an inline `new Set()` would change identity every render
// and re-run the columns memo (see "callback identity discipline" in CLAUDE.md).
const EMPTY_HIDDEN: ReadonlySet<string> = new Set();

// The only columns hideable via hiddenColumns; identity + metrics never hide.
const HIDEABLE_KEYS = new Set(['step', 'reward', 'data_source']);

// Freeform answers can be long; truncate heavily for the table column.
const FREEFORM_CELL_PREVIEW_LEN = 18;

// Sort key of the dedicated comments column (LeftPanel sorts on it by count).
export const COMMENT_COUNT_COLUMN = 'comment_count';
// Narrow: it holds an icon and a single digit for almost every corpus.
const COMMENT_COLUMN_WIDTH = 52;
// How much of the newest comment the column tooltip shows.
const COMMENT_TOOLTIP_LEN = 140;

// Helper to format a grade value
function formatGrade(grade: number | boolean | string, gradeType: string): string {
  if (gradeType === 'bool') return grade ? '✓' : '✗';
  if (gradeType === 'float') return (grade as number).toFixed(2);
  if (gradeType === 'freeform' || gradeType === 'categorical') {
    // Freeform prose / categorical label — collapse + truncate to fit the cell.
    const text = String(grade ?? '').trim().replace(/\s+/g, ' ');
    if (!text) return '—';
    if (text.length <= FREEFORM_CELL_PREVIEW_LEN) return text;
    return text.slice(0, FREEFORM_CELL_PREVIEW_LEN).trimEnd() + '…';
  }
  return String(grade);
}

// Helper to get grade color
function getGradeColor(grade: number | boolean | string, gradeType: string, isDarkMode: boolean): string {
  if (gradeType === 'bool') {
    return grade
      ? (isDarkMode ? 'text-teal-400' : 'text-teal-700')
      : (isDarkMode ? 'text-red-400' : 'text-red-600');
  }
  if (gradeType === 'freeform') {
    // No intrinsic ordering — render neutral.
    return isDarkMode ? 'text-gray-300' : 'text-gray-700';
  }
  if (gradeType === 'categorical') {
    // Categories have no good/bad ordering — neutral label color.
    return isDarkMode ? 'text-sky-300' : 'text-sky-700';
  }
  if (gradeType === 'int') {
    // Int scales are arbitrary (not 0-1), so the float thresholds below would
    // paint almost every int green — render neutral instead.
    return isDarkMode ? 'text-gray-200' : 'text-gray-700';
  }
  // For numeric grades, use a gradient
  const value = grade as number;
  if (value >= 0.7) return isDarkMode ? 'text-teal-400' : 'text-teal-700';
  if (value >= 0.4) return isDarkMode ? 'text-yellow-400' : 'text-yellow-600';
  return isDarkMode ? 'text-red-400' : 'text-red-600';
}

// Comments are human annotations, not judgements: they get their own compact
// column (below) instead of a grade column full of truncated prose. The list
// is append-only and holds deletion tombstones too — visibleComments is the
// only sanctioned way to read it.
function commentsOf(sample: Sample) {
  return visibleComments(sample.grades?.[COMMENTS_METRIC]);
}

/** "ada: looks like a reward hack" for the newest comment, for the tooltip. */
function commentTooltip(sample: Sample): string {
  const list = commentsOf(sample);
  if (list.length === 0) return 'No comments';
  const latest = list[list.length - 1];
  const text = String(latest.grade ?? '').trim().replace(/\s+/g, ' ');
  const preview = text.length > COMMENT_TOOLTIP_LEN
    ? text.slice(0, COMMENT_TOOLTIP_LEN).trimEnd() + '…'
    : text;
  const label = list.length === 1 ? '1 comment' : `${list.length} comments`;
  return `${label} · latest — ${authorOf(latest.model)}: ${preview}`;
}

// Get the latest grade entry for a sample and metric
function getGradeEntry(sample: Sample, metricName: string) {
  if (!sample.grades || !sample.grades[metricName]) return null;
  const grades = sample.grades[metricName];
  if (grades.length === 0) return null;
  return grades[grades.length - 1];
}

const ROW_HEIGHT = 36;

export function SampleTable({
  samples,
  selectedSampleId,
  onSelectSample,
  sortColumn,
  sortOrder,
  onSort,
  isDarkMode,
  idColumnKey = 'sample_index',
  hiddenColumns = EMPTY_HIDDEN,
}: SampleTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 50 });

  // Extract unique metric names from all samples. The reserved `comments`
  // metric is not a judgement — it gets the dedicated count column below.
  const metricNames = useMemo(() => {
    const metrics = new Set<string>();
    for (const sample of samples) {
      if (sample.grades) {
        for (const metricName of Object.keys(sample.grades)) {
          if (metricName === COMMENTS_METRIC) continue;
          metrics.add(metricName);
        }
      }
    }
    return Array.from(metrics).sort();
  }, [samples]);

  // The comments column only exists once someone has actually commented —
  // an always-empty column would cost width on every other corpus.
  const hasComments = useMemo(
    () => samples.some(s => commentsOf(s).length > 0),
    [samples],
  );

  // Truncate long metric names for display
  const truncateLabel = (label: string, maxLen: number = 14) => {
    if (label.length <= maxLen) return label;
    return label.slice(0, maxLen - 1) + '…';
  };

  // Per-metric column width: scale with the label so longer names stay
  // readable, clamped so a single metric never dominates the table.
  const metricWidths = useMemo(() => {
    const widths: Record<string, number> = {};
    for (const metric of metricNames) {
      const fullLabel = metric.charAt(0).toUpperCase() + metric.slice(1);
      widths[metric] = Math.min(130, Math.max(64, Math.round(fullLabel.length * 8.5) + 12));
    }
    return widths;
  }, [metricNames]);

  // Build column definitions
  const columns = useMemo(() => {
    const baseColumns = [
      idColumnKey === 'rollout_n'
        ? { key: 'rollout_n', label: 'Rollout', fullLabel: 'Rollout #', sortable: true, minWidth: 60 }
        : { key: 'sample_index', label: 'ID', fullLabel: 'Sample ID', sortable: true, minWidth: 48 },
      { key: 'step', label: 'Step', fullLabel: 'Step', sortable: true, minWidth: 48 },
      // Keep in sync with the hardcoded Reward row-cell width below.
      { key: 'reward', label: 'Reward', fullLabel: 'Reward', sortable: true, minWidth: 76 },
    ];

    // Add metric columns with truncated labels
    const metricColumns = metricNames.map(metric => {
      const fullLabel = metric.charAt(0).toUpperCase() + metric.slice(1);
      return {
        key: `grade:${metric}`,
        label: truncateLabel(fullLabel),
        fullLabel: fullLabel,
        sortable: true,
        minWidth: metricWidths[metric],
        isMetric: true,
        metricName: metric,
      };
    });

    const sourceColumn = { key: 'data_source', label: 'Source', fullLabel: 'Data Source', sortable: true, minWidth: 100, flex: true };

    // Header shows the drawer's own glyph rather than a truncated word — the
    // full word lives in the header tooltip (`fullLabel`).
    const commentColumns = hasComments
      ? [{
        key: COMMENT_COUNT_COLUMN,
        label: 'Comments',
        fullLabel: 'Comments',
        sortable: true,
        minWidth: COMMENT_COLUMN_WIDTH,
        isComments: true,
      }]
      : [];

    // Source sits right after Reward — it identifies the task, which reads
    // better next to the outcome than trailing the grade columns. Comments
    // follow it, ahead of the judge columns: they are about the rollout, not
    // one metric's verdict.
    return [...baseColumns, sourceColumn, ...commentColumns, ...metricColumns].filter(
      col => !(hiddenColumns.has(col.key) && HIDEABLE_KEYS.has(col.key)),
    );
  }, [metricNames, metricWidths, idColumnKey, hiddenColumns, hasComments]);

  // First-cell width follows the identity column definition so the header and
  // row cells never desync.
  const idColumnWidth = columns[0].minWidth;

  // Virtual scrolling with RAF-throttled scroll handler
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateVisibleRange = () => {
      const scrollTop = container.scrollTop;
      const viewportHeight = container.clientHeight;

      const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
      const end = Math.min(samples.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 5);

      setVisibleRange({ start, end });
      rafIdRef.current = null;
    };

    const handleScroll = () => {
      if (rafIdRef.current !== null) return; // Already scheduled
      rafIdRef.current = requestAnimationFrame(updateVisibleRange);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    updateVisibleRange(); // Initial calculation

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [samples.length]);

  // Keep the selected row visible (e.g. after arrow-key or search navigation).
  // Centers the row when it falls outside the viewport; no-op when visible.
  // The resulting native scroll event drives the existing RAF handler.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || container.clientHeight === 0) return;
    const idx = samples.findIndex(s => s.id === selectedSampleId);
    if (idx < 0) return;
    const rowTop = idx * ROW_HEIGHT;
    const { scrollTop, clientHeight } = container;
    if (rowTop < scrollTop || rowTop + ROW_HEIGHT > scrollTop + clientHeight) {
      container.scrollTop = Math.max(0, rowTop - clientHeight / 2 + ROW_HEIGHT / 2);
    }
  }, [selectedSampleId, samples]);

  // Arrow-key navigation: move the selection through the current display order.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (samples.length === 0) return;
    const currentIdx = samples.findIndex(s => s.id === selectedSampleId);
    const nextIdx = e.key === 'ArrowDown'
      ? Math.min(samples.length - 1, currentIdx + 1)
      : Math.max(0, currentIdx - 1);
    if (nextIdx !== currentIdx) {
      onSelectSample(samples[nextIdx].id);
    }
  };

  const totalHeight = samples.length * ROW_HEIGHT;

  // Sum of all column min-widths — applied to both the sticky header row and
  // the rows wrapper so they share one horizontal scroller and never desync.
  const tableMinWidth = columns.reduce((sum, c) => sum + c.minWidth, 0);

  // Helper to get column style
  const getColumnStyle = (col: typeof columns[0]) => {
    if ('flex' in col && col.flex) {
      return { minWidth: col.minWidth, flex: 1 };
    }
    return { width: col.minWidth, minWidth: col.minWidth };
  };

  // Helper to get text alignment class
  const getAlignClass = (col: typeof columns[0]) => {
    if (col.key === 'sample_index') return 'text-center';
    if (col.key === 'step') return 'text-center';
    if (col.key === 'reward') return 'text-right';
    if (col.key === 'data_source') return 'text-left';
    if (col.key.startsWith('grade:')) return 'text-center';
    return 'text-center';
  };

  // The comments header renders its glyph instead of a truncated word; the
  // word itself stays in the header's title tooltip.
  const isCommentsColumn = (col: typeof columns[0]) => 'isComments' in col && col.isComments;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Single scroller: sticky header + virtual rows share one horizontal scrollbar */}
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar focus:outline-none"
      >
        {/* Header — sticky so it stays put vertically but scrolls horizontally with the rows */}
        <div
          className={`sticky top-0 z-10 border-b ${isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-100 border-gray-300'}`}
          style={{ minWidth: tableMinWidth }}
        >
          <div className={`flex text-xs font-semibold uppercase ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {columns.map((col) => (
              <div
                key={col.key}
                className={`px-1 py-2 truncate ${getAlignClass(col)} ${col.sortable ? `cursor-pointer ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}` : ''}`}
                style={getColumnStyle(col)}
                onClick={() => col.sortable && onSort(col.key as SortColumn)}
                title={col.fullLabel}
              >
                <span className={`flex items-center gap-0.5 ${getAlignClass(col) === 'text-center' ? 'justify-center' : getAlignClass(col) === 'text-right' ? 'justify-end' : 'justify-start'}`}>
                  {isCommentsColumn(col) ? (
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 15 }}>
                      sticky_note_2
                    </span>
                  ) : (
                    <span className="truncate">{col.label}</span>
                  )}
                  {sortColumn === col.key && (
                    <span className={`flex-shrink-0 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`}>{sortOrder === 'asc' ? '↑' : '↓'}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Rows wrapper (virtual scrolling) */}
        <div style={{ height: totalHeight, position: 'relative', minWidth: tableMinWidth }}>
          {samples.slice(visibleRange.start, visibleRange.end).map((sample, idx) => {
            const actualIndex = visibleRange.start + idx;
            const isSelected = sample.id === selectedSampleId;
            const reward = sample.attributes.reward;
            
            return (
              <div
                key={sample.id}
                className={`flex items-center border-b cursor-pointer transition-colors ${
                  isDarkMode
                    ? `border-gray-700 ${isSelected ? 'bg-blue-900/50 hover:bg-blue-800/50' : 'hover:bg-gray-800'}`
                    : `border-gray-200 ${isSelected ? 'bg-blue-100 hover:bg-blue-200' : 'hover:bg-gray-50'}`
                }`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${actualIndex * ROW_HEIGHT}px)`,
                  height: ROW_HEIGHT,
                }}
                onClick={() => onSelectSample(sample.id)}
              >
                {/* Identity column: sample_index, or rollout_n when the ID column is degenerate */}
                <div style={{ width: idColumnWidth, minWidth: idColumnWidth }} className={`text-center text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                  {sample.attributes[idColumnKey]}
                </div>

                {/* Step */}
                {!hiddenColumns.has('step') && (
                  <div style={{ width: 48, minWidth: 48 }} className={`text-center text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    {sample.attributes.step}
                  </div>
                )}

                {/* Reward — width kept in sync with the reward column def above */}
                {!hiddenColumns.has('reward') && (
                  <div style={{ width: 76, minWidth: 76 }} className={`text-right text-sm font-medium pr-2 ${
                    reward >= 0
                      ? (isDarkMode ? 'text-teal-400' : 'text-teal-700')
                      : (isDarkMode ? 'text-red-400' : 'text-red-600')
                  }`}>
                    {reward}
                  </div>
                )}

                {/* Data Source — truncated to the last two segments; full path
                    in the tooltip. Rendered before the metric columns to
                    match the column defs above. */}
                {!hiddenColumns.has('data_source') && (
                  <div
                    style={{ minWidth: 100, flex: 1 }}
                    className={`px-2 text-xs truncate ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}
                    title={sample.attributes.data_source}
                  >
                    {sample.attributes.data_source.split('/').slice(-2).join('/')}
                  </div>
                )}

                {/* Comments — icon + count, tooltip carries the newest one.
                    Placeholder and value share the same centered box so the
                    column doesn't shimmy between rows. */}
                {hasComments && (() => {
                  const count = commentsOf(sample).length;
                  return (
                    <div
                      style={{ width: COMMENT_COLUMN_WIDTH, minWidth: COMMENT_COLUMN_WIDTH }}
                      className="flex items-center justify-center gap-0.5 overflow-hidden"
                      title={commentTooltip(sample)}
                    >
                      {count > 0 ? (
                        <>
                          <span
                            className={`material-symbols-outlined ${isDarkMode ? 'text-sky-400' : 'text-sky-600'}`}
                            aria-hidden="true"
                            style={{ fontSize: 14 }}
                          >
                            sticky_note_2
                          </span>
                          <span className={`text-xs font-data font-medium ${isDarkMode ? 'text-sky-300' : 'text-sky-700'}`}>
                            {count}
                          </span>
                        </>
                      ) : (
                        <span className={`text-xs ${isDarkMode ? 'text-gray-600' : 'text-gray-300'}`}>—</span>
                      )}
                    </div>
                  );
                })()}

                {/* Metric columns */}
                {metricNames.map(metricName => {
                  const gradeEntry = getGradeEntry(sample, metricName);

                  return (
                    <div
                      key={metricName}
                      style={{ width: metricWidths[metricName], minWidth: metricWidths[metricName] }}
                      className="flex items-center justify-center overflow-hidden"
                      title={gradeEntry ? `${metricName}: ${formatGrade(gradeEntry.grade, gradeEntry.grade_type)}\n${gradeEntry.explanation?.slice(0, 100) || ''}` : 'Not graded'}
                    >
                      {gradeEntry ? (
                        <span className={`text-sm font-medium truncate ${getGradeColor(gradeEntry.grade, gradeEntry.grade_type, isDarkMode)}`}>
                          {formatGrade(gradeEntry.grade, gradeEntry.grade_type)}
                        </span>
                      ) : (
                        <span className={`text-xs ${isDarkMode ? 'text-gray-600' : 'text-gray-300'}`}>—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
