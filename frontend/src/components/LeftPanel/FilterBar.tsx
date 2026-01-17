import { useState, useRef, useEffect } from 'react';
import type { SearchField } from '../../types';

const SEARCH_FIELD_OPTIONS: { value: SearchField; label: string }[] = [
  { value: 'chat', label: 'All messages' },
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'tool', label: 'Tool' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'all', label: 'All fields' },
  { value: 'data_source', label: 'Source' },
  { value: 'reward', label: 'Reward' },
  { value: 'step', label: 'Step' },
  { value: 'timestamp', label: 'Timestamp' },
  { value: 'experiment_name', label: 'Experiment' },
];

const FILTER_SUGGESTIONS: { field: string; type: string; examples: string[] }[] = [
  { field: 'reward', type: 'number', examples: ['reward > 0', 'reward == -5', 'reward >= -0.5'] },
  { field: 'step', type: 'number', examples: ['step == 1', 'step > 5', 'step <= 10'] },
  { field: 'sample_index', type: 'number', examples: ['sample_index < 100', 'sample_index == 0'] },
  { field: 'rollout_n', type: 'number', examples: ['rollout_n == 640', 'rollout_n > 500'] },
  { field: 'data_source', type: 'string', examples: ['data_source == maze', 'data_source == easy'] },
  { field: 'is_validate', type: 'boolean', examples: ['is_validate == true', 'is_validate == false'] },
];

const getSearchPlaceholder = (field: SearchField): string => {
  switch (field) {
    case 'chat': return 'Search all messages...';
    case 'system': return 'Search system messages...';
    case 'user': return 'Search user messages...';
    case 'assistant': return 'Search assistant responses...';
    case 'tool': return 'Search tool messages...';
    case 'reasoning': return 'Search reasoning/thinking blocks...';
    case 'all': return 'Search all fields...';
    case 'data_source': return 'Search data source...';
    case 'reward': return 'Search reward value...';
    case 'step': return 'Search step number...';
    case 'timestamp': return 'Search timestamp...';
    case 'experiment_name': return 'Search experiment name...';
    default: return 'Search...';
  }
};

interface FilterBarProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  searchField: SearchField;
  onSearchFieldChange: (field: SearchField) => void;
  filterExpression: string;
  onFilterChange: (value: string) => void;
  onNavigateNext: () => void;
  onNavigatePrev: () => void;
  matchCount: number;
  currentMatchIndex: number;
  isDarkMode: boolean;
}

export function FilterBar({
  searchTerm,
  onSearchChange,
  searchField,
  onSearchFieldChange,
  filterExpression,
  onFilterChange,
  onNavigateNext,
  onNavigatePrev,
  matchCount,
  currentMatchIndex,
  isDarkMode,
}: FilterBarProps) {
  const [showFilterSuggestions, setShowFilterSuggestions] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        filterInputRef.current &&
        !filterInputRef.current.contains(e.target as Node)
      ) {
        setShowFilterSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onNavigatePrev();
      } else {
        onNavigateNext();
      }
    }
  };

  const handleFilterKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowFilterSuggestions(false);
    } else if (e.key === 'Enter') {
      setShowFilterSuggestions(false);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    onFilterChange(suggestion);
    setShowFilterSuggestions(false);
    filterInputRef.current?.focus();
  };

  const hasMatches = matchCount > 0;
  return (
    <div className={`p-3 border-b space-y-2 ${isDarkMode ? 'border-gray-700' : ''}`}>
      {/* Filter expression */}
      <div className="flex items-center gap-1 relative">
        <div className="cursor-pointer flex items-center" title="Filter samples">
          <span className={`material-symbols-outlined ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`} style={{ fontSize: 17 }}>
            filter_alt
          </span>
        </div>
        <div className="flex-1 relative">
          <input
            ref={filterInputRef}
            type="text"
            placeholder="Filter samples... (e.g., reward > 0)"
            value={filterExpression}
            onChange={(e) => onFilterChange(e.target.value)}
            onFocus={() => setShowFilterSuggestions(true)}
            onKeyDown={handleFilterKeyDown}
            className={`w-full px-2 py-1 text-sm border rounded-md focus:outline-none focus:ring focus:ring-blue-500 focus:border-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-500' : 'border-gray-300'}`}
          />
          
          {/* Filter suggestions dropdown */}
          {showFilterSuggestions && (
            <div
              ref={suggestionsRef}
              className={`absolute top-full left-0 right-0 mt-1 border rounded-md shadow-lg z-50 max-h-64 overflow-y-auto ${isDarkMode ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-300'}`}
            >
              <div className={`p-2 border-b ${isDarkMode ? 'bg-gray-700 border-gray-600' : 'bg-gray-50'}`}>
                <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>Available filters</span>
              </div>
              {FILTER_SUGGESTIONS.map((suggestion) => (
                <div key={suggestion.field} className={`border-b last:border-b-0 ${isDarkMode ? 'border-gray-700' : ''}`}>
                  <div className={`px-3 py-1.5 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
                    <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>{suggestion.field}</span>
                    <span className={`text-xs ml-2 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>({suggestion.type})</span>
                  </div>
                  <div className="px-2 py-1">
                    {suggestion.examples.map((example) => (
                      <button
                        key={example}
                        onClick={() => handleSuggestionClick(example)}
                        className={`block w-full text-left px-2 py-1 text-sm rounded ${isDarkMode ? 'text-gray-300 hover:bg-blue-900 hover:text-blue-300' : 'text-gray-600 hover:bg-blue-50 hover:text-blue-700'}`}
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div className={`p-2 border-t ${isDarkMode ? 'bg-gray-700 border-gray-600' : 'bg-gray-50'}`}>
                <span className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Operators: == != &gt; &lt; &gt;= &lt;=
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="w-7 flex items-center justify-center">
          <span className={`material-symbols-outlined cursor-help ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`} style={{ fontSize: 17 }} title="Filter syntax: field operator value (e.g., reward > 0, step == 1)">
            help
          </span>
        </div>
        <button 
          className="flex items-center justify-center w-7 h-7 rounded-md text-white bg-blue-600 hover:bg-blue-700"
          title="Apply filter"
          onClick={() => setShowFilterSuggestions(false)}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>search</span>
        </button>
      </div>

      {/* Search in conversations */}
      <div className="h-7 flex items-center gap-1">
        <span className={`material-symbols-outlined ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`} style={{ fontSize: 17 }}>search</span>
        <select
          value={searchField}
          onChange={(e) => onSearchFieldChange(e.target.value as SearchField)}
          className={`px-1.5 py-0.5 text-sm border rounded-md focus:outline-none focus:ring focus:ring-blue-500 focus:border-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}`}
          title="Select search field"
        >
          {SEARCH_FIELD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="flex-1">
          <input
            type="text"
            placeholder={getSearchPlaceholder(searchField)}
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className={`w-full px-1.5 py-0.5 text-sm border rounded-md focus:outline-none focus:ring focus:ring-blue-500 focus:border-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-500' : 'border-gray-300'}`}
          />
        </div>
        {hasMatches && (
          <span className={`text-xs whitespace-nowrap ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {currentMatchIndex + 1}/{matchCount}
          </span>
        )}
        <button 
          className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${isDarkMode ? 'text-gray-300 bg-gray-700 hover:bg-gray-600' : 'text-gray-600 bg-gray-200 hover:bg-gray-300'}`}
          title="Previous match (Shift+Enter)"
          disabled={!hasMatches}
          onClick={onNavigatePrev}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>arrow_left</span>
        </button>
        <button 
          className={`flex items-center justify-center w-7 h-7 rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${isDarkMode ? 'text-gray-300 bg-gray-700 hover:bg-gray-600' : 'text-gray-600 bg-gray-200 hover:bg-gray-300'}`}
          title="Next match (Enter)"
          disabled={!hasMatches}
          onClick={onNavigateNext}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>arrow_right</span>
        </button>
      </div>
    </div>
  );
}
