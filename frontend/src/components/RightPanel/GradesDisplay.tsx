import { useState, useEffect, useMemo } from 'react';
import type { SampleGrades, Quote } from '../../types';

// Component for truncated explanations
function ExplanationText({ explanation, isDarkMode }: { explanation: string; isDarkMode: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const maxLength = 150;
  const shouldTruncate = explanation.length > maxLength;
  
  const displayText = shouldTruncate && !isExpanded 
    ? explanation.slice(0, maxLength) + '...' 
    : explanation;

  return (
    <div className={`text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
      <div className={`text-xs font-medium mb-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
        Explanation:
      </div>
      <p className="whitespace-pre-wrap text-xs leading-relaxed">
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
  onScrollToQuote?: (messageIndex: number) => void;
  isDarkMode: boolean;
  currentQuoteIndex?: number;
  onQuoteIndexChange?: (index: number) => void;
}

function formatGrade(grade: number | boolean, gradeType: string): string {
  if (gradeType === 'bool') return grade ? '✓ Yes' : '✗ No';
  if (gradeType === 'float') return (grade as number).toFixed(2);
  return String(grade);
}

function getGradeColor(grade: number | boolean, gradeType: string, isDarkMode: boolean): string {
  if (gradeType === 'bool') {
    return grade 
      ? (isDarkMode ? 'text-green-400' : 'text-green-600')
      : (isDarkMode ? 'text-red-400' : 'text-red-600');
  }
  const value = grade as number;
  if (value >= 0.7) return isDarkMode ? 'text-green-400' : 'text-green-600';
  if (value >= 0.4) return isDarkMode ? 'text-yellow-400' : 'text-yellow-600';
  return isDarkMode ? 'text-red-400' : 'text-red-600';
}

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

  if (!grades || Object.keys(grades).length === 0) {
    return null;
  }

  const metrics = Object.entries(grades);
  
  // Get sorted quotes for the selected metric
  const selectedQuotes = useMemo(() => {
    if (!selectedMetric || !grades[selectedMetric]) return [];
    const gradeList = grades[selectedMetric];
    const latest = gradeList[gradeList.length - 1];
    if (!latest?.quotes) return [];
    // Sort by message index, then by start position
    return [...latest.quotes].sort((a, b) => {
      if (a.message_index !== b.message_index) return a.message_index - b.message_index;
      return a.start - b.start;
    });
  }, [grades, selectedMetric]);

  return (
    <div className={`border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center justify-between px-4 py-2 transition-colors ${
          isDarkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`material-symbols-outlined ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`} style={{ fontSize: 18 }}>
            grade
          </span>
          <span className={`text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
            LLM Grades ({metrics.length} metric{metrics.length !== 1 ? 's' : ''})
          </span>
          {/* Quick preview of grades */}
          <div className="flex items-center gap-2 ml-2">
            {metrics.slice(0, 3).map(([metric, gradeList]) => {
              const latest = gradeList[gradeList.length - 1];
              if (!latest) return null;
              return (
                <span
                  key={metric}
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    isDarkMode ? 'bg-gray-700' : 'bg-gray-100'
                  } ${getGradeColor(latest.grade, latest.grade_type, isDarkMode)}`}
                >
                  {formatGrade(latest.grade, latest.grade_type)}
                </span>
              );
            })}
          </div>
        </div>
        <span 
          className={`material-symbols-outlined transition-transform duration-200 ${
            isDarkMode ? 'text-gray-400' : 'text-gray-500'
          } ${isExpanded ? '' : '-rotate-90'}`}
          style={{ fontSize: 18 }}
        >
          expand_less
        </span>
      </button>

      {/* Expanded content - limited height with scroll */}
      {isExpanded && (
        <div className={`px-3 pb-2 space-y-2 max-h-48 overflow-y-auto custom-scrollbar ${isDarkMode ? 'bg-gray-900/30' : 'bg-gray-50/50'}`}>
          {metrics.map(([metric, gradeList]) => {
            const latest = gradeList[gradeList.length - 1];
            if (!latest) return null;
            
            const isSelected = selectedMetric === metric;
            
            return (
              <div 
                key={metric}
                className={`rounded-lg border p-2 transition-all ${
                  isSelected
                    ? (isDarkMode ? 'border-purple-500 bg-purple-900/20' : 'border-purple-400 bg-purple-50')
                    : (isDarkMode ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-white')
                }`}
              >
                {/* Metric header */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
                      {metric}
                    </span>
                    <span className={`text-sm font-bold ${getGradeColor(latest.grade, latest.grade_type, isDarkMode)}`}>
                      {formatGrade(latest.grade, latest.grade_type)}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      if (isSelected) {
                        onSelectMetric(undefined);
                      } else {
                        onSelectMetric(metric);
                        onQuoteIndexChange?.(0); // Reset to first quote
                        // Scroll to first quote
                        if (latest.quotes && latest.quotes.length > 0 && onScrollToQuote) {
                          const firstQuote = latest.quotes.reduce((min, q) => 
                            q.message_index < min.message_index ? q : min, latest.quotes[0]);
                          onScrollToQuote(firstQuote.message_index);
                        }
                      }
                    }}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                      isSelected
                        ? (isDarkMode ? 'bg-purple-600 text-white' : 'bg-purple-500 text-white')
                        : (isDarkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-600 hover:bg-gray-300')
                    }`}
                    title={isSelected ? 'Click to hide highlights' : 'Click to highlight quotes in chat'}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                      {isSelected ? 'visibility_off' : 'format_quote'}
                    </span>
                    {isSelected ? 'Hide quotes' : 'Show quotes'}
                  </button>
                </div>

                {/* Explanation - truncated with expand option */}
                {latest.explanation && (
                  <ExplanationText 
                    explanation={latest.explanation} 
                    isDarkMode={isDarkMode} 
                  />
                )}

                {/* Quotes navigation and model info */}
                <div className={`flex items-center justify-between mt-1 text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  <span>
                    {latest.quotes && latest.quotes.length > 0 && (
                      <>
                        <span className="material-symbols-outlined mr-0.5" style={{ fontSize: 12, verticalAlign: 'middle' }}>
                          format_quote
                        </span>
                        {latest.quotes.length} quote{latest.quotes.length !== 1 ? 's' : ''}
                        {' • '}
                      </>
                    )}
                    {latest.model}
                  </span>
                  
                  {/* Quote navigation - only show when selected and has multiple quotes */}
                  {isSelected && selectedQuotes.length > 1 && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const newIndex = currentQuoteIndex <= 0 ? selectedQuotes.length - 1 : currentQuoteIndex - 1;
                          onQuoteIndexChange?.(newIndex);
                          if (onScrollToQuote && selectedQuotes[newIndex]) {
                            onScrollToQuote(selectedQuotes[newIndex].message_index);
                          }
                        }}
                        className={`p-0.5 rounded transition-colors ${
                          isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
                        }`}
                        title="Previous quote"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>chevron_left</span>
                      </button>
                      <span className={`min-w-[3rem] text-center ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>
                        {currentQuoteIndex + 1}/{selectedQuotes.length}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const newIndex = currentQuoteIndex >= selectedQuotes.length - 1 ? 0 : currentQuoteIndex + 1;
                          onQuoteIndexChange?.(newIndex);
                          if (onScrollToQuote && selectedQuotes[newIndex]) {
                            onScrollToQuote(selectedQuotes[newIndex].message_index);
                          }
                        }}
                        className={`p-0.5 rounded transition-colors ${
                          isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
                        }`}
                        title="Next quote"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>chevron_right</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
