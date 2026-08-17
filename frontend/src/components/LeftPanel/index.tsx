import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Sample, SortColumn, SortOrder, SearchCondition, SearchLogic } from '../../types';

// Build a random permutation rank (sample id → position) via Fisher–Yates.
// Module-level so the (impure) Math.random call never runs during render — it's
// invoked only from the shuffle event handler. Session-only: nothing persisted.
function buildRandomRank(samples: Sample[]): Map<number, number> {
  const ids = samples.map(s => s.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const rank = new Map<number, number>();
  ids.forEach((id, idx) => rank.set(id, idx));
  return rank;
}
import { SampleTable, COMMENT_COUNT_COLUMN } from './SampleTable';
import { FilterBar } from './FilterBar';
import { COMMENTS_METRIC, visibleComments } from '../../utils/humanGrades';
import { MetadataHeader } from './MetadataHeader';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { normalizeAssistantMessage, countMessageOccurrences } from '../../utils/parseContent';

// Helper to generate unique IDs (same pattern as FilterBar's search conditions)
const generateId = () => Math.random().toString(36).substring(2, 9);

// Hoisted empty set for the no-columns-hidden case (identity discipline).
const NO_HIDDEN_COLUMNS: ReadonlySet<string> = new Set();

// Human labels for the hidden-columns pill tooltip.
const HIDDEN_COLUMN_LABELS: Record<string, string> = {
  reward: 'Reward',
  step: 'Step',
  data_source: 'Source',
};

// Regex a filter condition must match: field operator value.
// Kept in sync with evaluateCondition inside the filteredSamples memo.
const FILTER_CONDITION_REGEX = /^(\w+)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/i;

// Base filter fields for expression validation. Keep in sync with
// BASE_FILTER_FIELDS in FilterBar.tsx (react-refresh forbids exporting
// constants from component files, hence the duplication).
const BASE_FILTER_FIELD_NAMES = [
  'reward',
  'step',
  'sample_index',
  'rollout_n',
  'data_source',
  'is_validate',
  'experiment_name',
];

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
  /** Per-file load failures that didn't block other files from loading. */
  loadWarnings?: string[];
  onDismissLoadWarnings?: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  onFilteredSamplesChange?: (samples: Sample[]) => void;
  onCurrentOccurrenceIndexChange?: (index: number) => void;
  messagesLoaded?: boolean;
  isSharedMode?: boolean;
  /** Bulk message hydration was skipped (huge file) — banner offers it. */
  hydrationSkipped?: boolean;
  onLoadAllMessages?: () => void;
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
  loadWarnings = [],
  onDismissLoadWarnings,
  isDarkMode,
  onToggleDarkMode,
  onFilteredSamplesChange,
  onCurrentOccurrenceIndexChange,
  messagesLoaded = true,
  isSharedMode = false,
  hydrationSkipped = false,
  onLoadAllMessages,
}: LeftPanelProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('sample_index');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [filterExpression, setFilterExpression] = useState('');
  // Session-only random ordering (id → rank). Held in state, set only by the
  // shuffle handler; never persisted to the URL or localStorage, so a reload
  // restores the natural order. Selection and deep links resolve by sample id /
  // attributes, not display position, so shuffling never breaks links.
  const [randomRank, setRandomRank] = useState<Map<number, number>>(() => new Map());
  const [currentOccurrenceIndex, setCurrentOccurrenceIndex] = useState(0); // Which occurrence within current sample

  // Debounce search/filter inputs to avoid re-filtering on every keystroke
  const debouncedSearchConditions = useDebouncedValue(searchConditions, 150);
  const debouncedFilterExpression = useDebouncedValue(filterExpression, 150);

  // When every loaded sample shares one sample_index (e.g. many rollouts of a
  // single prompt) the ID column is useless — show rollout_n instead, provided
  // it actually varies. Computed over the FULL sample list (not the filtered
  // one) so narrowing a filter never flips the column.
  const idColumnKey = useMemo<'sample_index' | 'rollout_n'>(
    () =>
      samples.length > 1 &&
      samples.every(s => s.attributes.sample_index === samples[0].attributes.sample_index) &&
      !samples.every(s => s.attributes.rollout_n === samples[0].attributes.rollout_n)
        ? 'rollout_n'
        : 'sample_index',
    [samples],
  );

  // Columns that are constant across ALL loaded samples AND equal to the
  // schema default carry no information — producers historically faked them
  // (reward: 0, step: 1) just to satisfy the viewer. Hidden behind a visible
  // pill, never silently. Computed over the FULL sample list (like
  // idColumnKey) so filtering can't flip column visibility mid-search.
  const hiddenDefaultColumns = useMemo<ReadonlySet<string>>(() => {
    if (samples.length === 0) return NO_HIDDEN_COLUMNS;
    const hidden = new Set<string>();
    if (samples.every(s => Number(s.attributes.reward) === 0)) hidden.add('reward');
    const firstStep = Number(samples[0].attributes.step);
    if (
      (firstStep === 0 || firstStep === 1) &&
      samples.every(s => Number(s.attributes.step) === firstStep)
    ) {
      hidden.add('step');
    }
    if (samples.every(s => (s.attributes.data_source || 'unknown') === 'unknown')) {
      hidden.add('data_source');
    }
    return hidden.size > 0 ? hidden : NO_HIDDEN_COLUMNS;
  }, [samples]);

  const [showHiddenColumns, setShowHiddenColumns] = useState(false);
  const effectiveHiddenColumns = showHiddenColumns ? NO_HIDDEN_COLUMNS : hiddenDefaultColumns;

  // Loading a different file (not just new grades on the same samples) drops any
  // session shuffle so the order is predictable on load. Done as an in-render state
  // adjustment (React's recommended alternative to an effect) keyed on the file list.
  const fileKey = filePaths.join('|');
  const [shuffledFileKey, setShuffledFileKey] = useState(fileKey);
  if (shuffledFileKey !== fileKey) {
    setShuffledFileKey(fileKey);
    setRandomRank(new Map());
    setSortColumn(c => (c === 'random' ? 'sample_index' : c));
  }

  // Filter and sort samples
  const filteredSamples = useMemo(() => {
    let result = [...samples];

    // Helper to check if a sample matches a single search condition
    const matchesCondition = (sample: Sample, condition: SearchCondition): boolean => {
      if (!condition.term.trim()) return true;
      
      const term = condition.term.toLowerCase();
      const attrs = sample.attributes;
      const field = condition.field;
      
      let matches = false;
      
      switch (field) {
        case 'chat':
          matches = sample.messages.some(msg => {
            const { reasoning, mainContent } = normalizeAssistantMessage(msg);
            const normalized = [mainContent, reasoning].filter(Boolean).join(' ');
            return normalized.toLowerCase().includes(term);
          });
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
            return normalizeAssistantMessage(msg).mainContent.toLowerCase().includes(term);
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
            const reasoning = normalizeAssistantMessage(msg).reasoning;
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
        default: {
          const inMessages = sample.messages.some(msg => {
            const { reasoning, mainContent } = normalizeAssistantMessage(msg);
            const normalized = [mainContent, reasoning].filter(Boolean).join(' ');
            return normalized.toLowerCase().includes(term);
          });
          const inAttributes = 
            attrs.data_source.toLowerCase().includes(term) ||
            attrs.experiment_name.toLowerCase().includes(term) ||
            String(attrs.reward).includes(term) ||
            String(attrs.step).includes(term) ||
            String(attrs.rollout_n).includes(term) ||
            String(attrs.sample_index).includes(term);
          const inTimestamp = sample.timestamp.toLowerCase().includes(term);
          matches = inMessages || inAttributes || inTimestamp;
          break;
        }
      }
      
      return condition.operator === 'contains' ? matches : !matches;
    };

    // Apply search conditions
    const activeConditions = debouncedSearchConditions.filter(c => c.term.trim());
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
    if (debouncedFilterExpression.trim()) {
      try {
        // Helper to evaluate a single condition
        const evaluateCondition = (
          condition: string,
          attrs: Record<string, unknown>
        ): boolean => {
          // Match: field operator value (supports contains operator)
          const match = condition.trim().match(FILTER_CONDITION_REGEX);
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
        const orGroups = debouncedFilterExpression.split(/\s+OR\s+/i);
        
        result = result.filter(sample => {
          // Create combined attrs including metric grades
          const attrs: Record<string, unknown> = {
            ...(sample.attributes as unknown as Record<string, unknown>),
          };
          
          // Add metric values to attrs
          if (sample.grades) {
            for (const [metricName, rawGrades] of Object.entries(sample.grades)) {
              // `comments` is append-only and carries deletion tombstones —
              // querying it must see the latest VISIBLE comment, never a
              // tombstone's empty grade. All comments deleted → the field is
              // absent, exactly as if nothing was ever written.
              const grades = metricName === COMMENTS_METRIC
                ? visibleComments(rawGrades)
                : rawGrades;
              if (grades.length > 0) {
                const grade = grades[grades.length - 1].grade;
                // Convert bool to number for comparison
                if (typeof grade === 'boolean') {
                  attrs[metricName] = grade ? 1 : 0;
                } else {
                  attrs[metricName] = grade;
                }
              }
            }
          }
          
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
      // Session-only random order: rank lookup by id (stable until reshuffle).
      // Ids not in the current shuffle (e.g. transiently after a data change)
      // fall to the end in natural order — a consistent total order either way.
      if (sortColumn === 'random') {
        const ra = randomRank.has(a.id) ? randomRank.get(a.id)! : 1e9 + a.attributes.sample_index;
        const rb = randomRank.has(b.id) ? randomRank.get(b.id)! : 1e9 + b.attributes.sample_index;
        return ra - rb;
      }

      let aVal: number | string;
      let bVal: number | string;

      // Handle grade:metricName columns
      if (sortColumn.startsWith('grade:')) {
        const metricName = sortColumn.slice(6); // Remove 'grade:' prefix
        const getGradeValue = (sample: Sample): number | string | null => {
          if (!sample.grades || !sample.grades[metricName]) return null;
          const grades = sample.grades[metricName];
          if (grades.length === 0) return null;
          const grade = grades[grades.length - 1].grade;
          // Convert bool to number for sorting
          if (typeof grade === 'boolean') return grade ? 1 : 0;
          // Freeform grades sort alphabetically (case-insensitive).
          if (typeof grade === 'string') return grade.toLowerCase();
          return grade as number;
        };
        const aG = getGradeValue(a);
        const bG = getGradeValue(b);
        // Handle null values - put them at the end
        if (aG === null && bG === null) return 0;
        if (aG === null) return sortOrder === 'asc' ? 1 : -1;
        if (bG === null) return sortOrder === 'asc' ? -1 : 1;
        aVal = aG;
        bVal = bG;
      } else {
        switch (sortColumn) {
          case 'sample_index':
            aVal = a.attributes.sample_index;
            bVal = b.attributes.sample_index;
            break;
          case 'rollout_n':
            aVal = a.attributes.rollout_n;
            bVal = b.attributes.rollout_n;
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
            aVal = a.messages.length || a.message_count || 0;
            bVal = b.messages.length || b.message_count || 0;
            break;
          // Dedicated comments column: sorts by how many notes a rollout has,
          // not by the text of the newest one (the grade path would do that).
          case COMMENT_COUNT_COLUMN:
            // Deleted comments are still in the log (append-only) but must
            // not count — visibleComments drops them and their tombstones.
            aVal = visibleComments(a.grades?.[COMMENTS_METRIC]).length;
            bVal = visibleComments(b.grades?.[COMMENTS_METRIC]).length;
            break;
          default:
            aVal = a.id;
            bVal = b.id;
        }
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
  }, [samples, debouncedSearchConditions, searchLogic, debouncedFilterExpression, sortColumn, sortOrder, randomRank]);

  // Known field names for filter-expression validation: base filter fields,
  // grade metric names, and every attribute key seen on any sample (attributes
  // include injected keys like source_file, so the static list alone is not enough).
  const knownFilterFields = useMemo(() => {
    const fields = new Set<string>(BASE_FILTER_FIELD_NAMES);
    for (const sample of samples) {
      for (const key of Object.keys(sample.attributes)) {
        fields.add(key);
      }
      if (sample.grades) {
        for (const metricName of Object.keys(sample.grades)) {
          fields.add(metricName);
        }
      }
    }
    return fields;
  }, [samples]);

  // Validate the filter expression so malformed conditions (which silently pass
  // everything) and unknown fields (which silently empty the table) get surfaced.
  const filterError = useMemo((): string | null => {
    const expr = debouncedFilterExpression.trim();
    if (!expr) return null;
    const conditions = expr
      .split(/\s+OR\s+/i)
      .flatMap(orGroup => orGroup.split(/\s+AND\s+/i));
    for (const condition of conditions) {
      const trimmed = condition.trim();
      if (!trimmed) continue;
      const match = trimmed.match(FILTER_CONDITION_REGEX);
      if (!match) return `Unrecognized condition: "${trimmed}"`;
      if (!knownFilterFields.has(match[1])) return `Unknown field: "${match[1]}"`;
    }
    return null;
  }, [debouncedFilterExpression, knownFilterFields]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortOrder('asc');
    }
  };

  // Reset both search conditions and the filter expression to their empty state.
  const handleClearFilters = useCallback(() => {
    onSearchConditionsChange([{ id: generateId(), field: 'chat', operator: 'contains', term: '' }]);
    setFilterExpression('');
  }, [onSearchConditionsChange]);

  // Shuffle into a fresh session-only random order (or reshuffle if already random).
  // Picking any column header exits random order via handleSort.
  const handleShuffle = useCallback(() => {
    setRandomRank(buildRandomRank(samples));
    setSortColumn('random');
    setSortOrder('asc');
  }, [samples]);

  const handleSelectSample = useCallback((id: number) => {
    setCurrentOccurrenceIndex(0);
    onSelectSample(id);
  }, [onSelectSample]);

  // Notify parent of filtered samples changes
  useEffect(() => {
    onFilteredSamplesChange?.(filteredSamples);
  }, [filteredSamples, onFilteredSamplesChange]);

  // Notify parent of current occurrence index changes
  useEffect(() => {
    onCurrentOccurrenceIndexChange?.(currentOccurrenceIndex);
  }, [currentOccurrenceIndex, onCurrentOccurrenceIndexChange]);

  // Calculate current match index based on selected sample.
  // Explicit null check: sample id 0 is a valid (and default) selection.
  const currentMatchIndex = useMemo(() => {
    if (selectedSampleId === null || filteredSamples.length === 0) return -1;
    return filteredSamples.findIndex(s => s.id === selectedSampleId);
  }, [selectedSampleId, filteredSamples]);

  // Count occurrences in the current sample (uses same normalized text + field scoping as MessageCard)
  const matchesInCurrentSample = useMemo(() => {
    if (selectedSampleId === null) return 0;
    
    const sample = samples.find(s => s.id === selectedSampleId);
    if (!sample) return 0;

    const messageFields = ['chat', 'system', 'user', 'assistant', 'tool', 'reasoning', 'all'];
    const activeMessageConditions = searchConditions.filter(
      c => c.operator === 'contains' && c.term.trim() && messageFields.includes(c.field)
    );
    
    if (activeMessageConditions.length === 0) return 0;

    let count = 0;
    sample.messages.forEach(msg => {
      count += countMessageOccurrences(msg, activeMessageConditions);
    });

    return count;
  }, [selectedSampleId, samples, searchConditions]);


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
    
    handleSelectSample(filteredSamples[nextIndex].id);
  }, [filteredSamples, currentMatchIndex, matchesInCurrentSample, currentOccurrenceIndex, handleSelectSample]);

  // Navigate to next sample (Shift+Enter) - always go to next sample
  const handleNavigateNextSample = useCallback(() => {
    if (filteredSamples.length === 0) return;
    
    const nextIndex = currentMatchIndex < 0 
      ? 0 
      : (currentMatchIndex + 1) % filteredSamples.length;
    
    handleSelectSample(filteredSamples[nextIndex].id);
  }, [filteredSamples, currentMatchIndex, handleSelectSample]);

  // Navigate to previous sample
  const handleNavigatePrevSample = useCallback(() => {
    if (filteredSamples.length === 0) return;
    
    const prevIndex = currentMatchIndex <= 0 
      ? filteredSamples.length - 1 
      : currentMatchIndex - 1;
    
    handleSelectSample(filteredSamples[prevIndex].id);
  }, [filteredSamples, currentMatchIndex, handleSelectSample]);

  return (
    <div className={`h-full flex flex-col ${isDarkMode ? 'bg-[var(--bg-primary)] text-gray-200' : 'bg-white text-gray-900'}`}>
      {/* Header with toolbar buttons */}
      <div className={`flex border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        {/* Static app-title mark — intentionally non-interactive (a link to "/"
            here silently reloaded the page and destroyed session state) */}
        <div
          className={`flex items-center px-3 py-2 border-r ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}
          title="Rollout Visualizer"
        >
          <span className={`material-symbols-outlined ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`} style={{ fontSize: 20 }} aria-hidden="true">
            analytics
          </span>
        </div>
        <div className={`flex overflow-hidden flex-1 ${isDarkMode ? 'bg-[var(--bg-primary)]' : 'bg-white'}`}>
          {!isSharedMode && (
            <button
              onClick={onOpenFileBrowser}
              className={`flex items-center px-3 py-2 ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
              title="Browse files"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>folder</span>
            </button>
          )}
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
          isSharedMode={isSharedMode}
          isRandomOrder={sortColumn === 'random'}
          onShuffle={handleShuffle}
        />

        <FilterBar
          searchConditions={searchConditions}
          onSearchConditionsChange={onSearchConditionsChange}
          searchLogic={searchLogic}
          onSearchLogicChange={onSearchLogicChange}
          filterExpression={filterExpression}
          onFilterChange={setFilterExpression}
          filterError={filterError}
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

        {/* Message search loading indicator */}
        {!messagesLoaded && (() => {
          const messageFields = ['chat', 'system', 'user', 'assistant', 'tool', 'reasoning', 'all'];
          const hasActiveMessageSearch = searchConditions.some(
            c => c.term.trim() && messageFields.includes(c.field)
          );
          return hasActiveMessageSearch ? (
            <div className={`px-3 py-1 text-xs flex items-center gap-1 ${isDarkMode ? 'text-yellow-400 bg-yellow-900/20' : 'text-yellow-600 bg-yellow-50'}`}>
              <span className="material-symbols-outlined animate-spin" style={{ fontSize: 12 }}>progress_activity</span>
              Message search limited — loading full content...
            </div>
          ) : null;
        })()}

        {/* Partial load failures — some files loaded, these didn't. Shown
            alongside the table (unlike `error`, which replaces it). */}
        {loadWarnings.length > 0 && (
          <div className={`px-3 py-2 text-xs flex items-start gap-2 border-b ${isDarkMode ? 'text-amber-300 bg-amber-900/20 border-amber-900/40' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>
            <span className="material-symbols-outlined shrink-0" style={{ fontSize: 14 }} aria-hidden="true">warning</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium">{loadWarnings.length} file{loadWarnings.length !== 1 ? 's' : ''} failed to load</div>
              {loadWarnings.map((w, i) => (
                <div key={i} className="truncate" title={w}>{w}</div>
              ))}
            </div>
            {onDismissLoadWarnings && (
              <button
                onClick={onDismissLoadWarnings}
                aria-label="Dismiss load warnings"
                title="Dismiss"
                className={`shrink-0 p-0.5 rounded ${isDarkMode ? 'hover:bg-amber-900/40' : 'hover:bg-amber-100'}`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden="true">close</span>
              </button>
            )}
          </div>
        )}

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

        {/* Sample table / empty states */}
        {!loading && !error && (
          samples.length === 0 ? (
            <div className={`flex-1 flex items-center justify-center ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              <div className="text-center">
                <span className="material-symbols-outlined" style={{ fontSize: 48 }}>folder_open</span>
                <p className="mt-2">No samples loaded</p>
                {!isSharedMode && (
                  <button
                    onClick={onOpenFileBrowser}
                    className="mt-3 px-3 py-1.5 text-sm rounded-md text-white bg-blue-600 hover:bg-blue-700"
                  >
                    Browse files
                  </button>
                )}
              </div>
            </div>
          ) : filteredSamples.length === 0 ? (
            <div className={`flex-1 flex items-center justify-center ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              <div className="text-center">
                <span className="material-symbols-outlined" style={{ fontSize: 48 }}>search_off</span>
                <p className="mt-2">No samples match your search or filter</p>
                <button
                  onClick={handleClearFilters}
                  className="mt-3 px-3 py-1.5 text-sm rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  Clear filters
                </button>
              </div>
            </div>
          ) : (
            <>
              {hydrationSkipped && (
                <div className={`px-2 py-1.5 text-xs border-b flex items-center gap-2 ${
                  isDarkMode ? 'border-gray-700 bg-blue-900/20 text-blue-300' : 'border-gray-200 bg-blue-50 text-blue-800'
                }`}>
                  <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 14 }}>bolt</span>
                  <span className="min-w-0 truncate" title="Large file: only metadata was loaded up front. The selected sample's messages load on demand; text search only covers messages that are loaded.">
                    Metadata-only load — messages hydrate per selected sample; search needs the full load.
                  </span>
                  <button
                    onClick={onLoadAllMessages}
                    className={`ml-auto flex-shrink-0 px-2 py-0.5 rounded-md font-medium ${
                      isDarkMode ? 'bg-blue-800/60 hover:bg-blue-700 text-blue-200' : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}
                  >
                    Load all messages
                  </button>
                </div>
              )}
              {hiddenDefaultColumns.size > 0 && (
                <div className={`px-2 py-1 text-xs border-b flex items-center ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                  <button
                    onClick={() => setShowHiddenColumns(v => !v)}
                    className={`px-2 py-0.5 rounded-full transition-colors ${
                      isDarkMode
                        ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700'
                    }`}
                    title={`${[...hiddenDefaultColumns].map(k => HIDDEN_COLUMN_LABELS[k] ?? k).join(', ')} — every loaded sample has the default value`}
                  >
                    {showHiddenColumns
                      ? 'Re-hide default columns'
                      : `${hiddenDefaultColumns.size} column${hiddenDefaultColumns.size === 1 ? '' : 's'} hidden (all default values)`}
                  </button>
                </div>
              )}
              <SampleTable
                samples={filteredSamples}
                selectedSampleId={selectedSampleId}
                onSelectSample={handleSelectSample}
                sortColumn={sortColumn}
                sortOrder={sortOrder}
                onSort={handleSort}
                isDarkMode={isDarkMode}
                idColumnKey={idColumnKey}
                hiddenColumns={effectiveHiddenColumns}
              />
            </>
          )
        )}
      </div>
    </div>
  );
}
