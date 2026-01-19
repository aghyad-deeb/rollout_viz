import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Sample, SortColumn, SortOrder, SearchCondition, SearchLogic } from '../../types';
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
  searchConditions: SearchCondition[];
  onSearchConditionsChange: (conditions: SearchCondition[]) => void;
  searchLogic: SearchLogic;
  onSearchLogicChange: (logic: SearchLogic) => void;
  loading: boolean;
  error: string | null;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  onFilteredSamplesChange?: (samples: Sample[]) => void;
  onCurrentOccurrenceIndexChange?: (index: number) => void;
}

export function LeftPanel({
  samples,
  selectedSampleId,
  onSelectSample,
  experimentName,
  filePaths,
  onFilePathsChange,
  onOpenFileBrowser,
  searchConditions,
  onSearchConditionsChange,
  searchLogic,
  onSearchLogicChange,
  loading,
  error,
  isDarkMode,
  onToggleDarkMode,
  onFilteredSamplesChange,
  onCurrentOccurrenceIndexChange,
}: LeftPanelProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('sample_index');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [filterExpression, setFilterExpression] = useState('');
  const [currentOccurrenceIndex, setCurrentOccurrenceIndex] = useState(0); // Which occurrence within current sample

  // Filter and sort samples
  const filteredSamples = useMemo(() => {
    let result = [...samples];

    // Helper to extract reasoning content from a message
    const getReasoningContent = (content: string): string | null => {
      const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
      const reasoningMatch = content.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
      return thinkMatch?.[1] || reasoningMatch?.[1] || null;
    };

    // Helper to check if a sample matches a single search condition
    const matchesCondition = (sample: Sample, condition: SearchCondition): boolean => {
      if (!condition.term.trim()) return true; // Empty term matches all
      
      const term = condition.term.toLowerCase();
      const attrs = sample.attributes;
      const field = condition.field;
      
      let matches = false;
      
      switch (field) {
        case 'chat':
          matches = sample.messages.some(msg => 
            msg.content.toLowerCase().includes(term)
          );
          break;
        
        case 'system':
          matches = sample.messages.some(msg => 
            msg.role === 'system' && msg.content.toLowerCase().includes(term)
          );
          break;
        
        case 'user':
          matches = sample.messages.some(msg => 
            msg.role === 'user' && msg.content.toLowerCase().includes(term)
          );
          break;
        
        case 'assistant':
          matches = sample.messages.some(msg => {
            if (msg.role !== 'assistant') return false;
            const contentWithoutReasoning = msg.content
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '');
            return contentWithoutReasoning.toLowerCase().includes(term);
          });
          break;
        
        case 'tool':
          matches = sample.messages.some(msg => 
            msg.role === 'tool' && msg.content.toLowerCase().includes(term)
          );
          break;
        
        case 'reasoning':
          matches = sample.messages.some(msg => {
            if (msg.role !== 'assistant') return false;
            const reasoning = getReasoningContent(msg.content);
            return reasoning ? reasoning.toLowerCase().includes(term) : false;
          });
          break;
        
        case 'data_source':
          matches = attrs.data_source.toLowerCase().includes(term);
          break;
        
        case 'reward':
          matches = String(attrs.reward).includes(term);
          break;
        
        case 'step':
          matches = String(attrs.step).includes(term);
          break;
        
        case 'timestamp':
          matches = sample.timestamp.toLowerCase().includes(term);
          break;
        
        case 'experiment_name':
          matches = attrs.experiment_name.toLowerCase().includes(term);
          break;
        
        case 'all':
        default:
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
          matches = inMessages || inAttributes || inTimestamp;
      }
      
      // Apply operator (contains or not_contains)
      return condition.operator === 'contains' ? matches : !matches;
    };

    // Apply search conditions
    const activeConditions = searchConditions.filter(c => c.term.trim());
    if (activeConditions.length > 0) {
      result = result.filter(sample => {
        if (searchLogic === 'AND') {
          return activeConditions.every(condition => matchesCondition(sample, condition));
        } else {
          return activeConditions.some(condition => matchesCondition(sample, condition));
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
  }, [samples, searchConditions, searchLogic, filterExpression, sortColumn, sortOrder]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortOrder('asc');
    }
  };

  // Notify parent of filtered samples changes
  useEffect(() => {
    onFilteredSamplesChange?.(filteredSamples);
  }, [filteredSamples, onFilteredSamplesChange]);

  // Notify parent of current occurrence index changes
  useEffect(() => {
    onCurrentOccurrenceIndexChange?.(currentOccurrenceIndex);
  }, [currentOccurrenceIndex, onCurrentOccurrenceIndexChange]);

  // Calculate current match index based on selected sample
  const currentMatchIndex = useMemo(() => {
    if (!selectedSampleId || filteredSamples.length === 0) return -1;
    return filteredSamples.findIndex(s => s.id === selectedSampleId);
  }, [selectedSampleId, filteredSamples]);

  // Count occurrences in the current sample for message-based searches
  const matchesInCurrentSample = useMemo(() => {
    if (!selectedSampleId) return 0;
    
    const sample = samples.find(s => s.id === selectedSampleId);
    if (!sample) return 0;

    // Only count for message-based search conditions
    const messageFields = ['chat', 'system', 'user', 'assistant', 'tool', 'reasoning', 'all'];
    const activeMessageConditions = searchConditions.filter(
      c => c.operator === 'contains' && c.term.trim() && messageFields.includes(c.field)
    );
    
    if (activeMessageConditions.length === 0) return 0;

    let count = 0;
    const firstCondition = activeMessageConditions[0]; // Use first condition for counting
    const term = firstCondition.term.toLowerCase();

    sample.messages.forEach(msg => {
      const content = msg.content.toLowerCase();
      let searchIndex = 0;
      while ((searchIndex = content.indexOf(term, searchIndex)) !== -1) {
        count++;
        searchIndex += term.length;
      }
    });

    return count;
  }, [selectedSampleId, samples, searchConditions]);

  // Reset occurrence index when sample changes
  useEffect(() => {
    setCurrentOccurrenceIndex(0);
  }, [selectedSampleId]);

  // Navigate to next occurrence (Enter) - within sample first, then next sample
  const handleNavigateNextOccurrence = useCallback(() => {
    if (filteredSamples.length === 0) return;
    
    // If there are more occurrences in current sample, go to next occurrence
    if (matchesInCurrentSample > 1 && currentOccurrenceIndex < matchesInCurrentSample - 1) {
      setCurrentOccurrenceIndex(prev => prev + 1);
      return;
    }
    
    // Otherwise, go to next sample and reset occurrence index
    const nextIndex = currentMatchIndex < 0 
      ? 0 
      : (currentMatchIndex + 1) % filteredSamples.length;
    
    setCurrentOccurrenceIndex(0);
    onSelectSample(filteredSamples[nextIndex].id);
  }, [filteredSamples, currentMatchIndex, matchesInCurrentSample, currentOccurrenceIndex, onSelectSample]);

  // Navigate to next sample (Shift+Enter) - always go to next sample
  const handleNavigateNextSample = useCallback(() => {
    if (filteredSamples.length === 0) return;
    
    const nextIndex = currentMatchIndex < 0 
      ? 0 
      : (currentMatchIndex + 1) % filteredSamples.length;
    
    setCurrentOccurrenceIndex(0);
    onSelectSample(filteredSamples[nextIndex].id);
  }, [filteredSamples, currentMatchIndex, onSelectSample]);

  // Navigate to previous sample
  const handleNavigatePrevSample = useCallback(() => {
    if (filteredSamples.length === 0) return;
    
    const prevIndex = currentMatchIndex <= 0 
      ? filteredSamples.length - 1 
      : currentMatchIndex - 1;
    
    setCurrentOccurrenceIndex(0);
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
          searchConditions={searchConditions}
          onSearchConditionsChange={onSearchConditionsChange}
          searchLogic={searchLogic}
          onSearchLogicChange={onSearchLogicChange}
          filterExpression={filterExpression}
          onFilterChange={setFilterExpression}
          onNavigateNextOccurrence={handleNavigateNextOccurrence}
          onNavigateNextSample={handleNavigateNextSample}
          onNavigatePrevSample={handleNavigatePrevSample}
          matchCount={filteredSamples.length}
          currentMatchIndex={currentMatchIndex}
          matchesInCurrentSample={matchesInCurrentSample}
          currentOccurrenceIndex={currentOccurrenceIndex}
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
