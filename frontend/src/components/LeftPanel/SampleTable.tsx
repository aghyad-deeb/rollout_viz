import { useRef, useEffect, useState } from 'react';
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

interface Column {
  key: SortColumn | 'favourite' | 'grades';
  label: string;
  sortable: boolean;
}

const COLUMNS: Column[] = [
  { key: 'favourite', label: '★', sortable: false },
  { key: 'sample_index', label: 'ID', sortable: true },
  { key: 'step', label: 'Step', sortable: true },
  { key: 'reward', label: 'Reward', sortable: true },
  { key: 'grades', label: 'Grades', sortable: false },
  { key: 'data_source', label: 'Source', sortable: true },
];

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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className={`border-b flex-shrink-0 ${isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-100 border-gray-300'}`}>
        <div className={`flex text-xs font-semibold uppercase ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {COLUMNS.map((col) => (
            <div
              key={col.key}
              className={`px-2 py-2 ${col.sortable ? `cursor-pointer ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}` : ''} ${
                col.key === 'favourite' ? 'w-8 text-center' : 
                col.key === 'sample_index' ? 'w-12 text-center' :
                col.key === 'step' ? 'w-12 text-center' :
                col.key === 'reward' ? 'w-16 text-right' :
                col.key === 'grades' ? 'w-20 text-center' :
                'flex-1 min-w-0'
              }`}
              onClick={() => col.sortable && onSort(col.key as SortColumn)}
            >
              <span className="flex items-center gap-1">
                {col.label}
                {sortColumn === col.key && (
                  <span className={isDarkMode ? 'text-blue-400' : 'text-blue-500'}>{sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Scrollable body */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-y-auto custom-scrollbar"
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
                <div className="w-8 flex items-center justify-center">
                  <button 
                    className={`transition-colors ${isDarkMode ? 'text-gray-500 hover:text-yellow-400' : 'text-gray-400 hover:text-yellow-500'}`}
                    title="Add to favourites"
                    onClick={(e) => e.stopPropagation()}
                  >
                    ☆
                  </button>
                </div>

                {/* Sample ID */}
                <div className={`w-12 text-center text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                  {sample.attributes.sample_index}
                </div>

                {/* Step */}
                <div className={`w-12 text-center text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {sample.attributes.step}
                </div>

                {/* Reward */}
                <div className={`w-16 text-right text-sm font-medium pr-2 ${
                  reward >= 0 
                    ? (isDarkMode ? 'text-green-400' : 'text-green-600')
                    : (isDarkMode ? 'text-red-400' : 'text-red-600')
                }`}>
                  {reward}
                </div>

                {/* Grades */}
                <div className="w-20 flex items-center justify-center gap-1">
                  {sample.grades && Object.entries(sample.grades).length > 0 ? (
                    Object.entries(sample.grades).slice(0, 3).map(([metric, grades]) => {
                      const latest = grades[grades.length - 1];
                      if (!latest) return null;
                      return (
                        <span
                          key={metric}
                          className={`text-xs font-medium ${getGradeColor(latest.grade, latest.grade_type, isDarkMode)}`}
                          title={`${metric}: ${formatGrade(latest.grade, latest.grade_type)}`}
                        >
                          {formatGrade(latest.grade, latest.grade_type)}
                        </span>
                      );
                    })
                  ) : (
                    <span className={`text-xs ${isDarkMode ? 'text-gray-600' : 'text-gray-300'}`}>—</span>
                  )}
                </div>

                {/* Data Source */}
                <div className={`flex-1 min-w-0 px-2 text-xs truncate ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
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
