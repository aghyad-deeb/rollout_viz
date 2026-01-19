import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { Sample, SearchCondition, Quote } from '../../types';
import { MessageCard } from './MessageCard';

interface ChatViewProps {
  sample: Sample;
  searchConditions: SearchCondition[]; // Global search conditions from left panel
  currentOccurrenceIndex: number; // Which occurrence to scroll to (0-indexed)
  isDarkMode: boolean;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; message?: number; highlight?: string }) => string;
  highlightedMessageIndex: number | null;
  highlightedText: string | null;
  onClearHighlight: () => void;
  selectedGradeMetric?: string; // Which metric's quotes to highlight
}

interface LocalMatch {
  messageIndex: number;
  matchIndex: number; // Which occurrence within the message
}

export function ChatView({ 
  sample, 
  searchConditions,
  currentOccurrenceIndex,
  isDarkMode,
  filePath,
  generateLink,
  highlightedMessageIndex,
  highlightedText,
  onClearHighlight,
  selectedGradeMetric,
}: ChatViewProps) {
  // Extract quotes from the selected grade metric
  const gradeQuotes = useMemo((): Quote[] => {
    if (!selectedGradeMetric || !sample.grades || !sample.grades[selectedGradeMetric]) {
      return [];
    }
    const grades = sample.grades[selectedGradeMetric];
    if (grades.length === 0) return [];
    
    // Get quotes from the latest grade
    const latestGrade = grades[grades.length - 1];
    return latestGrade.quotes || [];
  }, [sample.grades, selectedGradeMetric]);
  // Get active search terms for highlighting (only 'contains' conditions with non-empty terms)
  const activeSearchTerms = useMemo(() => 
    searchConditions
      .filter(c => c.operator === 'contains' && c.term.trim())
      .map(c => c.term.trim()),
    [searchConditions]
  );
  
  // Get the first active condition for scroll targeting
  const primarySearchTerm = activeSearchTerms[0] || '';

  // Calculate the starting occurrence index for each message (cumulative count)
  // This tells MessageCard which global index its first occurrence corresponds to
  const messageOccurrenceStarts = useMemo(() => {
    const starts: number[] = [];
    let cumulativeCount = 0;
    
    sample.messages.forEach((message) => {
      starts.push(cumulativeCount);
      
      // Count occurrences in this message for all active search terms
      if (activeSearchTerms.length > 0) {
        const contentLower = message.content.toLowerCase();
        activeSearchTerms.forEach(term => {
          const termLower = term.toLowerCase();
          let searchIndex = 0;
          while ((searchIndex = contentLower.indexOf(termLower, searchIndex)) !== -1) {
            cumulativeCount++;
            searchIndex += term.length;
          }
        });
      }
    });
    
    return starts;
  }, [sample.messages, activeSearchTerms]);

  const [localSearchTerm, setLocalSearchTerm] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastScrolledSampleId = useRef<number | null>(null);
  const lastScrolledSearchTerm = useRef<string>('');

  // Find all matches in the current chat
  const localMatches = useMemo((): LocalMatch[] => {
    if (!localSearchTerm.trim()) return [];
    
    const matches: LocalMatch[] = [];
    const term = localSearchTerm.toLowerCase();
    
    sample.messages.forEach((message, messageIndex) => {
      const content = message.content.toLowerCase();
      let searchIndex = 0;
      let matchIndex = 0;
      
      while ((searchIndex = content.indexOf(term, searchIndex)) !== -1) {
        matches.push({ messageIndex, matchIndex });
        searchIndex += term.length;
        matchIndex++;
      }
    });
    
    return matches;
  }, [sample.messages, localSearchTerm]);

  // Reset current match when search term changes
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [localSearchTerm]);

  // Scroll to current match
  const scrollToMatch = useCallback((matchIdx: number) => {
    if (localMatches.length === 0 || matchIdx >= localMatches.length) return;
    
    const match = localMatches[matchIdx];
    const messageElement = messageRefs.current.get(match.messageIndex);
    
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [localMatches]);

  // Navigate to next/prev match
  const navigateMatch = useCallback((direction: 'next' | 'prev') => {
    if (localMatches.length === 0) return;
    
    let newIndex: number;
    if (direction === 'next') {
      newIndex = (currentMatchIndex + 1) % localMatches.length;
    } else {
      newIndex = (currentMatchIndex - 1 + localMatches.length) % localMatches.length;
    }
    
    setCurrentMatchIndex(newIndex);
    scrollToMatch(newIndex);
  }, [currentMatchIndex, localMatches.length, scrollToMatch]);

  // Handle keyboard shortcuts
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        navigateMatch('prev');
      } else {
        navigateMatch('next');
      }
    } else if (e.key === 'Escape') {
      setIsSearchOpen(false);
      setLocalSearchTerm('');
    }
  };

  // Toggle search with Ctrl/Cmd + F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Track which occurrence we last scrolled to
  const lastScrolledOccurrenceIndex = useRef<number>(-1);

  // Auto-scroll to the Nth global search match
  useEffect(() => {
    // Skip if no search term
    if (!primarySearchTerm) {
      lastScrolledSearchTerm.current = '';
      lastScrolledOccurrenceIndex.current = -1;
      return;
    }
    
    // Skip if we already scrolled to this exact occurrence for this sample
    if (
      lastScrolledSampleId.current === sample.id &&
      lastScrolledSearchTerm.current === primarySearchTerm &&
      lastScrolledOccurrenceIndex.current === currentOccurrenceIndex
    ) {
      return;
    }
    
    // Remember what we scrolled to (do this early to prevent re-runs)
    lastScrolledSampleId.current = sample.id;
    lastScrolledSearchTerm.current = primarySearchTerm;
    lastScrolledOccurrenceIndex.current = currentOccurrenceIndex;
    
    // Wait for the DOM to render with highlighted marks, then scroll to the Nth one
    const timeoutId = setTimeout(() => {
      if (messagesContainerRef.current) {
        // Find all highlighted search term elements
        const highlights = messagesContainerRef.current.querySelectorAll('.global-search-highlight');
        const targetHighlight = highlights[currentOccurrenceIndex];
        if (targetHighlight) {
          targetHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (highlights.length > 0) {
          // Fallback to first if index is out of range
          highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }, 50);
    
    return () => clearTimeout(timeoutId);
  }, [sample.id, sample.messages, primarySearchTerm, currentOccurrenceIndex]);

  // Get the message index for the current match (for highlighting)
  const currentMatchMessageIndex = localMatches.length > 0 ? localMatches[currentMatchIndex]?.messageIndex : null;

  // Register message ref
  const setMessageRef = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) {
      messageRefs.current.set(index, element);
    } else {
      messageRefs.current.delete(index);
    }
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Local search bar */}
      {isSearchOpen && (
        <div className={`flex items-center gap-2 px-4 py-2 border-b ${isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'}`}>
          <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            search
          </span>
          <input
            type="text"
            value={localSearchTerm}
            onChange={(e) => setLocalSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search in this chat..."
            className={`flex-1 px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500 ${
              isDarkMode ? 'bg-gray-700 border-gray-600 text-gray-200 placeholder-gray-500' : 'bg-white border-gray-300'
            }`}
            autoFocus
          />
          {localSearchTerm && (
            <span className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {localMatches.length > 0 
                ? `${currentMatchIndex + 1}/${localMatches.length}`
                : 'No matches'
              }
            </span>
          )}
          <button
            onClick={() => navigateMatch('prev')}
            disabled={localMatches.length === 0}
            className={`p-1 rounded disabled:opacity-50 ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            title="Previous match (Shift+Enter)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              keyboard_arrow_up
            </span>
          </button>
          <button
            onClick={() => navigateMatch('next')}
            disabled={localMatches.length === 0}
            className={`p-1 rounded disabled:opacity-50 ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            title="Next match (Enter)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              keyboard_arrow_down
            </span>
          </button>
          <button
            onClick={() => {
              setIsSearchOpen(false);
              setLocalSearchTerm('');
            }}
            className={`p-1 rounded ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
            title="Close search (Esc)"
          >
            <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              close
            </span>
          </button>
        </div>
      )}

      {/* Search toggle button (when search is closed) */}
      {!isSearchOpen && (
        <div className={`flex justify-end px-4 py-1 border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <button
            onClick={() => setIsSearchOpen(true)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
              isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
            title="Search in chat (Ctrl+F)"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>search</span>
            Search chat
          </button>
        </div>
      )}

      {/* Messages area */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
        {sample.messages.map((message, index) => (
          <div key={index} ref={(el) => setMessageRef(index, el)}>
            <MessageCard 
              message={message} 
              index={index}
              searchConditions={searchConditions}
              localSearchTerm={localSearchTerm}
              isCurrentLocalMatch={currentMatchMessageIndex === index}
              isDarkMode={isDarkMode}
              rolloutN={sample.attributes.rollout_n}
              filePath={filePath}
              generateLink={generateLink}
              isHighlighted={highlightedMessageIndex === index}
              highlightedText={highlightedMessageIndex === index ? highlightedText : null}
              onClearHighlight={onClearHighlight}
              messageOccurrenceStart={messageOccurrenceStarts[index] ?? 0}
              currentOccurrenceIndex={currentOccurrenceIndex}
              gradeQuotes={gradeQuotes}
            />
          </div>
        ))}
      </div>

      {/* Sample metadata footer */}
      <div className={`border-t p-3 ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
        <div className={`flex flex-wrap gap-4 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Step:</span>{' '}
            <span className="font-semibold">{sample.attributes.step}</span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Reward:</span>{' '}
            <span className={`font-semibold ${sample.attributes.reward >= 0 ? (isDarkMode ? 'text-green-400' : 'text-green-600') : (isDarkMode ? 'text-red-400' : 'text-red-600')}`}>
              {sample.attributes.reward}
            </span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Rollout:</span>{' '}
            <span className="font-semibold">{sample.attributes.rollout_n}</span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Source:</span>{' '}
            <span className="font-semibold">{sample.attributes.data_source}</span>
          </div>
          <div>
            <span className={`font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Timestamp:</span>{' '}
            <span className="font-semibold">{sample.timestamp}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
