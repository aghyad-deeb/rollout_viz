import { useState, useMemo, useCallback } from 'react';
import type { Sample, SortColumn, SortOrder, SearchField } from '../../types';
import { SampleTable } from './SampleTable';
import { FilterBar } from './FilterBar';
import { MetadataHeader } from './MetadataHeader';

interface LeftPanelProps {
  samples: Sample[];
  selectedSampleId: number | null;
  onSelectSample: (id: number) => void;
  experimentName: string;
  filePaths: string[];
  onFilePathsChange: (paths: string[]) => void;
  onOpenFileBrowser: () => void;
  searchTerm: string;
  onSearchTermChange: (term: string) => void;
  searchField: SearchField;
  onSearchFieldChange: (field: SearchField) => void;
  loading: boolean;
  error: string | null;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
}

export function LeftPanel({
  samples,
  selectedSampleId,
  onSelectSample,
  experimentName,
  filePaths,
  onFilePathsChange,
  onOpenFileBrowser,
  searchTerm,
  onSearchTermChange,
  searchField,
  onSearchFieldChange,
  loading,
  error,
  isDarkMode,
  onToggleDarkMode,
}: LeftPanelProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('sample_index');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [filterExpression, setFilterExpression] = useState('');

  // Filter and sort samples
  const filteredSamples = useMemo(() => {
    let result = [...samples];

    // Helper to extract reasoning content from a message
    const getReasoningContent = (content: string): string | null => {
      const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
      const reasoningMatch = content.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
      return thinkMatch?.[1] || reasoningMatch?.[1] || null;
    };

    // Apply search filter based on selected field
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(sample => {
        const attrs = sample.attributes;
        
        switch (searchField) {
          case 'chat':
            // Search in all messages
            return sample.messages.some(msg => 
              msg.content.toLowerCase().includes(term)
            );
          
          case 'system':
            // Search only in system messages
            return sample.messages.some(msg => 
              msg.role === 'system' && msg.content.toLowerCase().includes(term)
            );
          
          case 'user':
            // Search only in user messages
            return sample.messages.some(msg => 
              msg.role === 'user' && msg.content.toLowerCase().includes(term)
            );
          
          case 'assistant':
            // Search only in assistant messages (excluding reasoning)
            return sample.messages.some(msg => {
              if (msg.role !== 'assistant') return false;
              // Remove reasoning blocks from content before searching
              const contentWithoutReasoning = msg.content
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '');
              return contentWithoutReasoning.toLowerCase().includes(term);
            });
          
          case 'tool':
            // Search only in tool messages
            return sample.messages.some(msg => 
              msg.role === 'tool' && msg.content.toLowerCase().includes(term)
            );
          
          case 'reasoning':
            // Search only in reasoning/thinking blocks within assistant messages
            return sample.messages.some(msg => {
              if (msg.role !== 'assistant') return false;
              const reasoning = getReasoningContent(msg.content);
              return reasoning ? reasoning.toLowerCase().includes(term) : false;
            });
          
          case 'data_source':
            return attrs.data_source.toLowerCase().includes(term);
          
          case 'reward':
            return String(attrs.reward).includes(term);
          
          case 'step':
            return String(attrs.step).includes(term);
          
          case 'timestamp':
            return sample.timestamp.toLowerCase().includes(term);
          
          case 'experiment_name':
            return attrs.experiment_name.toLowerCase().includes(term);
          
          case 'all':
          default:
            // Search across all fields
            const inMessages = sample.messages.some(msg => 
              msg.content.toLowerCase().includes(term)
            );
            const inAttributes = 
              attrs.data_source.toLowerCase().includes(term) ||
              attrs.experiment_name.toLowerCase().includes(term) ||
              String(attrs.reward).includes(term) ||
              String(attrs.step).includes(term) ||
              String(attrs.rollout_n).includes(term) ||
              String(attrs.sample_index).includes(term);
            const inTimestamp = sample.timestamp.toLowerCase().includes(term);
            return inMessages || inAttributes || inTimestamp;
        }
      });
    }

    // Apply filter expression with AND/OR support
    if (filterExpression.trim()) {
      try {
        // Helper to evaluate a single condition
        const evaluateCondition = (
          condition: string,
          attrs: Record<string, unknown>
        ): boolean => {
          // Match: field operator value (supports contains operator)
          const match = condition.trim().match(/^(\w+)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/i);
          if (!match) return true; // Invalid condition passes
          
          const [, field, operator, valueStr] = match;
          const rawValue = valueStr.trim();
          const sampleValue = attrs[field];
          
          // Handle undefined fields
          if (sampleValue === undefined) return false;
          
          // Parse value based on type
          let value: string | number | boolean;
          if (rawValue.toLowerCase() === 'true') {
            value = true;
          } else if (rawValue.toLowerCase() === 'false') {
            value = false;
          } else if (!isNaN(Number(rawValue))) {
            value = Number(rawValue);
          } else {
            value = rawValue;
          }
          
          const op = operator.toLowerCase();
          
          switch (op) {
            case '==': 
              // Handle string comparison (case-insensitive for strings)
              if (typeof sampleValue === 'string' && typeof value === 'string') {
                return sampleValue.toLowerCase() === value.toLowerCase();
              }
              return sampleValue === value;
            case '!=':
              if (typeof sampleValue === 'string' && typeof value === 'string') {
                return sampleValue.toLowerCase() !== value.toLowerCase();
              }
              return sampleValue !== value;
            case '>': return (sampleValue as number) > (value as number);
            case '<': return (sampleValue as number) < (value as number);
            case '>=': return (sampleValue as number) >= (value as number);
            case '<=': return (sampleValue as number) <= (value as number);
            case 'contains':
              if (typeof sampleValue === 'string' && typeof value === 'string') {
                return sampleValue.toLowerCase().includes(value.toLowerCase());
              }
              return String(sampleValue).toLowerCase().includes(String(value).toLowerCase());
            default: return true;
          }
        };

        // Parse expression with AND/OR support
        // Split by OR first (lower precedence), then AND (higher precedence)
        const orGroups = filterExpression.split(/\s+OR\s+/i);
        
        result = result.filter(sample => {
          const attrs = sample.attributes as unknown as Record<string, unknown>;
          
          // OR: any group must match
          return orGroups.some(orGroup => {
            // AND: all conditions in group must match
            const andConditions = orGroup.split(/\s+AND\s+/i);
            return andConditions.every(condition => 
              evaluateCondition(condition, attrs)
            );
          });
        });
      } catch {
        // Ignore invalid filter expressions
      }
    }

    // Sort
    result.sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      switch (sortColumn) {
        case 'sample_index':
          aVal = a.attributes.sample_index;
          bVal = b.attributes.sample_index;
          break;
        case 'step':
          aVal = a.attributes.step;
          bVal = b.attributes.step;
          break;
        case 'data_source':
          aVal = a.attributes.data_source;
          bVal = b.attributes.data_source;
          break;
        case 'reward':
          aVal = a.attributes.reward;
          bVal = b.attributes.reward;
          break;
        case 'num_messages':
          aVal = a.messages.length;
          bVal = b.messages.length;
          break;
        default:
          aVal = a.id;
          bVal = b.id;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'asc' 
          ? aVal.localeCompare(bVal) 
          : bVal.localeCompare(aVal);
      }
      
      return sortOrder === 'asc' 
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });

    return result;
  }, [samples, searchTerm, searchField, filterExpression, sortColumn, sortOrder]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortOrder('asc');
    }
  };

  // Calculate current match index based on selected sample
  const currentMatchIndex = useMemo(() => {
    if (!selectedSampleId || filteredSamples.length === 0) return -1;
    return filteredSamples.findIndex(s => s.id === selectedSampleId);
  }, [selectedSampleId, filteredSamples]);

  // Navigate to next matching sample
  const handleNavigateNext = useCallback(() => {
    if (filteredSamples.length === 0) return;
    
    const nextIndex = currentMatchIndex < 0 
      ? 0 
      : (currentMatchIndex + 1) % filteredSamples.length;
    
    onSelectSample(filteredSamples[nextIndex].id);
  }, [filteredSamples, currentMatchIndex, onSelectSample]);

  // Navigate to previous matching sample
  const handleNavigatePrev = useCallback(() => {
    if (filteredSamples.length === 0) return;
    
    const prevIndex = currentMatchIndex <= 0 
      ? filteredSamples.length - 1 
      : currentMatchIndex - 1;
    
    onSelectSample(filteredSamples[prevIndex].id);
  }, [filteredSamples, currentMatchIndex, onSelectSample]);

  return (
    <div className={`h-full flex flex-col ${isDarkMode ? 'bg-[#1a1a2e] text-gray-200' : 'bg-white text-gray-900'}`}>
      {/* Header with tabs */}
      <div className={`flex border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <a 
          className={`flex items-center px-3 py-2 transition-colors border-r ${isDarkMode ? 'border-gray-700 hover:bg-gray-800' : 'border-gray-200 hover:bg-sky-50'}`}
          href="/"
          title="Go to main page"
        >
          <span className={`material-symbols-outlined ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`} style={{ fontSize: 20 }}>
            analytics
          </span>
        </a>
        <div className={`flex overflow-hidden flex-1 ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
          <button
            onClick={onOpenFileBrowser}
            className={`flex items-center px-3 py-2 border-b-2 border-transparent ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
            title="Browse files"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>folder</span>
          </button>
          <button className={`flex items-center px-3 py-2 border-b-2 border-transparent ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>description</span>
          </button>
          <button className={`flex items-center px-3 py-2 border-b-2 ${isDarkMode ? 'text-blue-400 border-blue-400 bg-blue-500/20' : 'text-blue-600 border-blue-600 bg-blue-500/10'}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>list</span>
          </button>
          <button className={`flex items-center px-3 py-2 border-b-2 border-transparent ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>graph_1</span>
          </button>
        </div>
        {/* Dark mode toggle */}
        <button
          onClick={onToggleDarkMode}
          className={`flex items-center px-3 py-2 transition-colors ${isDarkMode ? 'text-yellow-400 hover:bg-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
            {isDarkMode ? 'light_mode' : 'dark_mode'}
          </span>
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <MetadataHeader
          experimentName={experimentName}
          filePaths={filePaths}
          onFilePathsChange={onFilePathsChange}
          totalSamples={samples.length}
          filteredCount={filteredSamples.length}
          isDarkMode={isDarkMode}
        />

        <FilterBar
          searchTerm={searchTerm}
          onSearchChange={onSearchTermChange}
          searchField={searchField}
          onSearchFieldChange={onSearchFieldChange}
          filterExpression={filterExpression}
          onFilterChange={setFilterExpression}
          onNavigateNext={handleNavigateNext}
          onNavigatePrev={handleNavigatePrev}
          matchCount={filteredSamples.length}
          currentMatchIndex={currentMatchIndex}
          isDarkMode={isDarkMode}
          samples={samples}
        />

        {/* Loading/Error states */}
        {loading && (
          <div className={`p-4 text-center ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            <span className="material-symbols-outlined animate-spin" style={{ fontSize: 24 }}>progress_activity</span>
            <p className="mt-2">Loading samples...</p>
          </div>
        )}

        {error && (
          <div className={`p-4 text-center ${isDarkMode ? 'text-red-400' : 'text-red-500'}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>error</span>
            <p className="mt-2">{error}</p>
          </div>
        )}

        {/* Sample table */}
        {!loading && !error && (
          <SampleTable
            samples={filteredSamples}
            selectedSampleId={selectedSampleId}
            onSelectSample={onSelectSample}
            sortColumn={sortColumn}
            sortOrder={sortOrder}
            onSort={handleSort}
            isDarkMode={isDarkMode}
          />
        )}
      </div>
    </div>
  );
}
