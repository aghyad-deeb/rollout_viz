import { useRef, useEffect, useState, useMemo } from 'react';
import type { Sample, SortColumn, SortOrder } from '../../types';

interface SampleTableProps {
  samples: Sample[];
  selectedSampleId: number | null;
  onSelectSample: (id: number) => void;
  sortColumn: SortColumn;
  sortOrder: SortOrder;
  onSort: (column: SortColumn) => void;
  isDarkMode: boolean;
}

// Helper to format a grade value
function formatGrade(grade: number | boolean, gradeType: string): string {
  if (gradeType === 'bool') return grade ? '✓' : '✗';
  if (gradeType === 'float') return (grade as number).toFixed(2);
  return String(grade);
}

// Helper to get grade color
function getGradeColor(grade: number | boolean, gradeType: string, isDarkMode: boolean): string {
  if (gradeType === 'bool') {
    return grade 
      ? (isDarkMode ? 'text-green-400' : 'text-green-600')
      : (isDarkMode ? 'text-red-400' : 'text-red-600');
  }
  // For numeric grades, use a gradient
  const value = grade as number;
  if (value >= 0.7) return isDarkMode ? 'text-green-400' : 'text-green-600';
  if (value >= 0.4) return isDarkMode ? 'text-yellow-400' : 'text-yellow-600';
  return isDarkMode ? 'text-red-400' : 'text-red-600';
}

// Get the latest grade value for a sample and metric
function getGradeValue(sample: Sample, metricName: string): number | boolean | null {
  if (!sample.grades || !sample.grades[metricName]) return null;
  const grades = sample.grades[metricName];
  if (grades.length === 0) return null;
  return grades[grades.length - 1].grade;
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
}: SampleTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 50 });

  // Extract unique metric names from all samples
  const metricNames = useMemo(() => {
    const metrics = new Set<string>();
    for (const sample of samples) {
      if (sample.grades) {
        for (const metricName of Object.keys(sample.grades)) {
          metrics.add(metricName);
        }
      }
    }
    return Array.from(metrics).sort();
  }, [samples]);

  // Truncate long metric names for display
  const truncateLabel = (label: string, maxLen: number = 8) => {
    if (label.length <= maxLen) return label;
    return label.slice(0, maxLen - 1) + '…';
  };

  // Build column definitions
  const columns = useMemo(() => {
    const baseColumns = [
      { key: 'favourite', label: '★', fullLabel: 'Favourite', sortable: false, minWidth: 32 },
      { key: 'sample_index', label: 'ID', fullLabel: 'Sample ID', sortable: true, minWidth: 48 },
      { key: 'step', label: 'Step', fullLabel: 'Step', sortable: true, minWidth: 48 },
      { key: 'reward', label: 'Reward', fullLabel: 'Reward', sortable: true, minWidth: 64 },
    ];
    
    // Add metric columns with truncated labels
    const metricColumns = metricNames.map(metric => {
      const fullLabel = metric.charAt(0).toUpperCase() + metric.slice(1);
      return {
        key: `grade:${metric}`,
        label: truncateLabel(fullLabel),
        fullLabel: fullLabel,
        sortable: true,
        minWidth: 56,
        isMetric: true,
        metricName: metric,
      };
    });
    
    const sourceColumn = { key: 'data_source', label: 'Source', fullLabel: 'Data Source', sortable: true, minWidth: 100, flex: true };
    
    return [...baseColumns, ...metricColumns, sourceColumn];
  }, [metricNames]);

  // Virtual scrolling
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      const viewportHeight = container.clientHeight;
      
      const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
      const end = Math.min(samples.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 5);
      
      setVisibleRange({ start, end });
    };

    container.addEventListener('scroll', handleScroll);
    handleScroll();

    return () => container.removeEventListener('scroll', handleScroll);
  }, [samples.length]);

  const totalHeight = samples.length * ROW_HEIGHT;

  // Helper to get column style
  const getColumnStyle = (col: typeof columns[0]) => {
    if ('flex' in col && col.flex) {
      return { minWidth: col.minWidth, flex: 1 };
    }
    return { width: col.minWidth, minWidth: col.minWidth };
  };

  // Helper to get text alignment class
  const getAlignClass = (col: typeof columns[0]) => {
    if (col.key === 'favourite') return 'text-center';
    if (col.key === 'sample_index') return 'text-center';
    if (col.key === 'step') return 'text-center';
    if (col.key === 'reward') return 'text-right';
    if (col.key === 'data_source') return 'text-left';
    if (col.key.startsWith('grade:')) return 'text-center';
    return 'text-center';
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className={`border-b flex-shrink-0 overflow-x-auto ${isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-100 border-gray-300'}`}>
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
                <span className="truncate">{col.label}</span>
                {sortColumn === col.key && (
                  <span className={`flex-shrink-0 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`}>{sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Scrollable body */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar"
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
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
                {/* Favourite */}
                <div style={{ width: 32, minWidth: 32 }} className="flex items-center justify-center">
                  <button 
                    className={`transition-colors ${isDarkMode ? 'text-gray-500 hover:text-yellow-400' : 'text-gray-400 hover:text-yellow-500'}`}
                    title="Add to favourites"
                    onClick={(e) => e.stopPropagation()}
                  >
                    ☆
                  </button>
                </div>

                {/* Sample ID */}
                <div style={{ width: 48, minWidth: 48 }} className={`text-center text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                  {sample.attributes.sample_index}
                </div>

                {/* Step */}
                <div style={{ width: 48, minWidth: 48 }} className={`text-center text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {sample.attributes.step}
                </div>

                {/* Reward */}
                <div style={{ width: 64, minWidth: 64 }} className={`text-right text-sm font-medium pr-2 ${
                  reward >= 0 
                    ? (isDarkMode ? 'text-green-400' : 'text-green-600')
                    : (isDarkMode ? 'text-red-400' : 'text-red-600')
                }`}>
                  {reward}
                </div>

                {/* Metric columns */}
                {metricNames.map(metricName => {
                  const gradeEntry = getGradeEntry(sample, metricName);
                  
                  return (
                    <div 
                      key={metricName} 
                      style={{ width: 56, minWidth: 56 }}
                      className="flex items-center justify-center"
                      title={gradeEntry ? `${metricName}: ${formatGrade(gradeEntry.grade, gradeEntry.grade_type)}\n${gradeEntry.explanation?.slice(0, 100) || ''}` : 'Not graded'}
                    >
                      {gradeEntry ? (
                        <span className={`text-sm font-medium ${getGradeColor(gradeEntry.grade, gradeEntry.grade_type, isDarkMode)}`}>
                          {formatGrade(gradeEntry.grade, gradeEntry.grade_type)}
                        </span>
                      ) : (
                        <span className={`text-xs ${isDarkMode ? 'text-gray-600' : 'text-gray-300'}`}>—</span>
                      )}
                    </div>
                  );
                })}

                {/* Data Source */}
                <div style={{ minWidth: 100, flex: 1 }} className={`px-2 text-xs truncate ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  {sample.attributes.data_source.split('/').slice(-2).join('/')}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
