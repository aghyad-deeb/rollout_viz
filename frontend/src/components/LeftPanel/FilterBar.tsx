import { useState, useRef, useEffect, useMemo } from 'react';
import type { SearchField, Sample } from '../../types';

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

// Field definitions with types
const FILTER_FIELDS: { name: string; type: 'number' | 'string' | 'boolean' }[] = [
  { name: 'reward', type: 'number' },
  { name: 'step', type: 'number' },
  { name: 'sample_index', type: 'number' },
  { name: 'rollout_n', type: 'number' },
  { name: 'data_source', type: 'string' },
  { name: 'is_validate', type: 'boolean' },
  { name: 'experiment_name', type: 'string' },
];

// Operators by field type
const OPERATORS_BY_TYPE: Record<string, string[]> = {
  number: ['==', '!=', '>', '<', '>=', '<='],
  string: ['==', '!=', 'contains'],
  boolean: ['==', '!='],
};

const LOGICAL_OPERATORS = ['AND', 'OR'];

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

type SuggestionType = 'field' | 'operator' | 'value' | 'logical';

interface Suggestion {
  type: SuggestionType;
  value: string;
  display: string;
  description?: string;
}

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
  samples: Sample[]; // Added to extract unique values
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
  samples,
}: FilterBarProps) {
  const [showFilterSuggestions, setShowFilterSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Extract unique values from samples for each field
  const uniqueValues = useMemo(() => {
    const values: Record<string, Set<string | number>> = {};
    
    FILTER_FIELDS.forEach(field => {
      values[field.name] = new Set();
    });

    samples.forEach(sample => {
      const attrs = sample.attributes;
      if (attrs.reward !== undefined) values['reward'].add(attrs.reward);
      if (attrs.step !== undefined) values['step'].add(attrs.step);
      if (attrs.sample_index !== undefined) values['sample_index'].add(attrs.sample_index);
      if (attrs.rollout_n !== undefined) values['rollout_n'].add(attrs.rollout_n);
      if (attrs.data_source) values['data_source'].add(attrs.data_source);
      if (attrs.is_validate !== undefined) values['is_validate'].add(attrs.is_validate ? 'true' : 'false');
      if (attrs.experiment_name) values['experiment_name'].add(attrs.experiment_name);
    });

    return values;
  }, [samples]);

  // Parse the current filter expression to determine context
  const parseContext = useMemo(() => {
    const text = filterExpression;
    const trimmedText = text.trim();
    
    if (!trimmedText) {
      return { type: 'field' as SuggestionType, currentToken: '', fieldType: null, fieldName: null };
    }

    // Check if we just typed AND or OR (with or without trailing space)
    if (/\s+(AND|OR)\s*$/i.test(text)) {
      return { type: 'field' as SuggestionType, currentToken: '', fieldType: null, fieldName: null };
    }

    // Split by logical operators while preserving them
    const parts = trimmedText.split(/\s+(AND|OR)\s+/i);
    const lastPart = parts[parts.length - 1];
    
    // Check if we're at the end with a space (ready for next token)
    const endsWithSpace = text.endsWith(' ');
    
    // Parse the last condition - keep empty strings to detect trailing spaces
    const tokens = lastPart.split(/\s+/).filter(t => t !== '');
    
    if (tokens.length === 0) {
      return { type: 'field' as SuggestionType, currentToken: '', fieldType: null, fieldName: null };
    }

    // Check if we have a complete expression (field operator value)
    const fieldInfo = FILTER_FIELDS.find(f => f.name.toLowerCase() === tokens[0].toLowerCase());
    
    if (tokens.length === 1) {
      if (fieldInfo && endsWithSpace) {
        // Field complete, need operator
        return { type: 'operator' as SuggestionType, currentToken: '', fieldType: fieldInfo.type, fieldName: fieldInfo.name };
      }
      // Still typing field name
      return { type: 'field' as SuggestionType, currentToken: tokens[0], fieldType: null, fieldName: null };
    }
    
    if (tokens.length === 2) {
      // Have field, typing or completed operator
      if (fieldInfo) {
        const operators = OPERATORS_BY_TYPE[fieldInfo.type];
        const isCompleteOperator = operators.some(op => op.toLowerCase() === tokens[1].toLowerCase());
        if (isCompleteOperator && endsWithSpace) {
          // Operator complete, need value
          return { type: 'value' as SuggestionType, currentToken: '', fieldType: fieldInfo.type, fieldName: fieldInfo.name };
        }
        // Still typing operator (or operator complete but no space yet)
        return { type: 'operator' as SuggestionType, currentToken: tokens[1], fieldType: fieldInfo.type, fieldName: fieldInfo.name };
      }
      return { type: 'operator' as SuggestionType, currentToken: tokens[1], fieldType: null, fieldName: null };
    }
    
    if (tokens.length >= 3) {
      // Have field and operator, typing value or complete
      if (fieldInfo) {
        const valueToken = tokens.slice(2).join(' ');
        // Check if expression looks complete (has a value and ends with space)
        if (valueToken.length > 0 && endsWithSpace) {
          // Expression complete, suggest logical operators
          return { type: 'logical' as SuggestionType, currentToken: '', fieldType: null, fieldName: null };
        }
        return { type: 'value' as SuggestionType, currentToken: valueToken, fieldType: fieldInfo.type, fieldName: fieldInfo.name };
      }
    }

    return { type: 'field' as SuggestionType, currentToken: '', fieldType: null, fieldName: null };
  }, [filterExpression]);

  // Generate suggestions based on context
  const suggestions = useMemo((): Suggestion[] => {
    const { type, currentToken, fieldType, fieldName } = parseContext;
    const token = currentToken.toLowerCase();

    switch (type) {
      case 'field': {
        return FILTER_FIELDS
          .filter(f => f.name.toLowerCase().includes(token))
          .map(f => ({
            type: 'field' as SuggestionType,
            value: f.name,
            display: f.name,
            description: f.type,
          }));
      }

      case 'operator': {
        const operators = fieldType ? OPERATORS_BY_TYPE[fieldType] : ['==', '!=', '>', '<', '>=', '<=', 'contains'];
        return operators
          .filter(op => op.toLowerCase().includes(token))
          .map(op => ({
            type: 'operator' as SuggestionType,
            value: op,
            display: op,
            description: getOperatorDescription(op),
          }));
      }

      case 'value': {
        if (!fieldName) return [];
        const values = Array.from(uniqueValues[fieldName] || []);
        
        // Sort values
        const sortedValues = values.sort((a, b) => {
          if (typeof a === 'number' && typeof b === 'number') return a - b;
          return String(a).localeCompare(String(b));
        });

        // Filter by current token
        const filtered = sortedValues
          .filter(v => String(v).toLowerCase().includes(token))
          .slice(0, 15); // Limit to 15 suggestions

        return filtered.map(v => ({
          type: 'value' as SuggestionType,
          value: String(v),
          display: String(v),
          description: fieldType === 'number' ? 'number' : fieldType === 'boolean' ? 'boolean' : 'string',
        }));
      }

      case 'logical': {
        return LOGICAL_OPERATORS.map(op => ({
          type: 'logical' as SuggestionType,
          value: op,
          display: op,
          description: op === 'AND' ? 'Both conditions must match' : 'Either condition must match',
        }));
      }

      default:
        return [];
    }
  }, [parseContext, uniqueValues]);

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [suggestions]);

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
    if (!showFilterSuggestions || suggestions.length === 0) {
      if (e.key === 'Escape') {
        setShowFilterSuggestions(false);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedSuggestionIndex(prev => 
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedSuggestionIndex(prev => 
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        if (suggestions[selectedSuggestionIndex]) {
          applySuggestion(suggestions[selectedSuggestionIndex]);
        }
        break;
      case 'Escape':
        setShowFilterSuggestions(false);
        break;
    }
  };

  const applySuggestion = (suggestion: Suggestion) => {
    const { type } = parseContext;
    let newValue = filterExpression;
    
    // Remove the current token being typed
    if (type === 'field') {
      // Replace partial field with suggestion
      const parts = filterExpression.split(/\s+(AND|OR)\s+/i);
      parts[parts.length - 1] = suggestion.value + ' ';
      newValue = parts.join(' ').replace(/\s+(AND|OR)\s+/gi, (match) => match.toUpperCase());
      // Handle case where we're at the start
      if (filterExpression.trim() === '' || !filterExpression.includes('AND') && !filterExpression.includes('OR')) {
        newValue = suggestion.value + ' ';
      } else {
        // Preserve the logical operators
        const match = filterExpression.match(/^(.*\s+(AND|OR)\s+)/i);
        if (match) {
          newValue = match[1] + suggestion.value + ' ';
        }
      }
    } else if (type === 'operator') {
      // Add operator after field
      const trimmed = filterExpression.trimEnd();
      const lastSpace = trimmed.lastIndexOf(' ');
      newValue = trimmed.slice(0, lastSpace + 1) + suggestion.value + ' ';
    } else if (type === 'value') {
      // Add value - need to handle strings with spaces
      const trimmed = filterExpression.trimEnd();
      // Find where the value starts (after operator)
      const parts = trimmed.split(/\s+/);
      // Keep everything except the partial value
      const baseExpr = parts.slice(0, -1).join(' ');
      // Check if there's already a partial value
      const lastPart = parts[parts.length - 1];
      const operators = ['==', '!=', '>', '<', '>=', '<=', 'contains'];
      if (operators.includes(lastPart)) {
        // No partial value yet
        newValue = trimmed + ' ' + suggestion.value + ' ';
      } else {
        // Replace partial value
        newValue = baseExpr + ' ' + suggestion.value + ' ';
      }
    } else if (type === 'logical') {
      newValue = filterExpression.trimEnd() + ' ' + suggestion.value + ' ';
    }

    onFilterChange(newValue);
    filterInputRef.current?.focus();
    
    // Keep suggestions open for next step (except after logical operators give field suggestions)
    if (type !== 'logical') {
      setShowFilterSuggestions(true);
    }
  };

  const handleSuggestionClick = (suggestion: Suggestion) => {
    applySuggestion(suggestion);
  };

  const hasMatches = matchCount > 0;

  const getSuggestionTypeLabel = (type: SuggestionType): string => {
    switch (type) {
      case 'field': return 'Fields';
      case 'operator': return 'Operators';
      case 'value': return 'Values';
      case 'logical': return 'Combine with';
      default: return '';
    }
  };

  const getSuggestionIcon = (type: SuggestionType): string => {
    switch (type) {
      case 'field': return 'data_object';
      case 'operator': return 'compare_arrows';
      case 'value': return 'tag';
      case 'logical': return 'join';
      default: return 'chevron_right';
    }
  };

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
            placeholder="Filter samples... (e.g., reward > 0 AND step == 1)"
            value={filterExpression}
            onChange={(e) => onFilterChange(e.target.value)}
            onFocus={() => setShowFilterSuggestions(true)}
            onKeyDown={handleFilterKeyDown}
            className={`w-full px-2 py-1 text-sm border rounded-md focus:outline-none focus:ring focus:ring-blue-500 focus:border-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-500' : 'border-gray-300'}`}
          />
          
          {/* Filter suggestions dropdown */}
          {showFilterSuggestions && suggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              className={`absolute top-full left-0 right-0 mt-1 border rounded-md shadow-lg z-50 max-h-72 overflow-y-auto ${isDarkMode ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-300'}`}
            >
              <div className={`px-3 py-1.5 border-b flex items-center gap-2 ${isDarkMode ? 'bg-gray-700 border-gray-600' : 'bg-gray-50'}`}>
                <span className={`material-symbols-outlined text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  {getSuggestionIcon(parseContext.type)}
                </span>
                <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                  {getSuggestionTypeLabel(parseContext.type)}
                </span>
                {parseContext.fieldName && (
                  <span className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                    for {parseContext.fieldName}
                  </span>
                )}
              </div>
              <div className="py-1">
                {suggestions.map((suggestion, index) => (
                  <button
                    key={`${suggestion.type}-${suggestion.value}`}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className={`block w-full text-left px-3 py-1.5 text-sm flex items-center justify-between ${
                      index === selectedSuggestionIndex
                        ? isDarkMode 
                          ? 'bg-blue-900 text-blue-200' 
                          : 'bg-blue-100 text-blue-800'
                        : isDarkMode 
                          ? 'text-gray-300 hover:bg-gray-700' 
                          : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <span className="font-mono">{suggestion.display}</span>
                    {suggestion.description && (
                      <span className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        {suggestion.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className={`px-3 py-1.5 border-t text-xs ${isDarkMode ? 'bg-gray-700 border-gray-600 text-gray-500' : 'bg-gray-50 text-gray-400'}`}>
                <span className="mr-3">↑↓ navigate</span>
                <span className="mr-3">↵ select</span>
                <span>esc close</span>
              </div>
            </div>
          )}
        </div>
        <div className="w-7 flex items-center justify-center">
          <span className={`material-symbols-outlined cursor-help ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`} style={{ fontSize: 17 }} title="Filter syntax: field operator value (e.g., reward > 0 AND step == 1)">
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

function getOperatorDescription(op: string): string {
  switch (op) {
    case '==': return 'equals';
    case '!=': return 'not equals';
    case '>': return 'greater than';
    case '<': return 'less than';
    case '>=': return 'greater or equal';
    case '<=': return 'less or equal';
    case 'contains': return 'contains text';
    default: return '';
  }
}
