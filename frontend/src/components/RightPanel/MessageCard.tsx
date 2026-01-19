import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { Message, SearchCondition, SearchField, Quote } from '../../types';

interface MessageCardProps {
  message: Message;
  index: number;
  searchConditions: SearchCondition[]; // Global search conditions
  localSearchTerm?: string; // Local search term for this chat
  isCurrentLocalMatch?: boolean; // Is this message the current local search match
  isDarkMode: boolean;
  rolloutN: number;
  filePath: string;
  generateLink: (options: { file: string; rollout?: number; message?: number; highlight?: string }) => string;
  isHighlighted: boolean;
  highlightedText: string | null;
  onClearHighlight: () => void;
  // For tracking which occurrence is "current" in global search
  messageOccurrenceStart: number; // Starting index of occurrences in this message (0-based global)
  currentOccurrenceIndex: number; // Which occurrence is currently focused
  // Grade quotes to highlight
  gradeQuotes?: Quote[];
}

const ROLE_CONFIG = {
  system: {
    icon: 'contextual_token',
    className: 'message-system',
    headerClassName: 'message-system-header',
    buttonClassName: 'message-system-button',
  },
  user: {
    icon: 'person',
    className: 'message-user',
    headerClassName: 'message-user-header',
    buttonClassName: 'message-user-button',
  },
  assistant: {
    icon: 'network_intelligence',
    className: 'message-assistant',
    headerClassName: 'message-assistant-header',
    buttonClassName: 'message-assistant-button',
  },
  tool: {
    icon: 'build',
    className: 'message-tool',
    headerClassName: 'message-tool-header',
    buttonClassName: 'message-tool-button',
  },
} as const;

interface SelectionPopup {
  show: boolean;
  x: number;
  y: number;
  text: string;
}

export function MessageCard({ 
  message, 
  index, 
  searchConditions,
  localSearchTerm = '',
  isCurrentLocalMatch = false,
  isDarkMode,
  rolloutN,
  filePath,
  generateLink,
  isHighlighted,
  highlightedText,
  onClearHighlight,
  messageOccurrenceStart,
  currentOccurrenceIndex,
  gradeQuotes = [],
}: MessageCardProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopup>({ show: false, x: 0, y: 0, text: '' });
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedSelection, setCopiedSelection] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  
  const config = ROLE_CONFIG[message.role] || ROLE_CONFIG.user;

  // Scroll to this message if it's highlighted from URL
  useEffect(() => {
    if (isHighlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isHighlighted]);

  // Handle text selection
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !contentRef.current) {
      return;
    }

    const selectedText = selection.toString().trim();
    if (selectedText.length === 0) {
      setSelectionPopup(prev => ({ ...prev, show: false }));
      return;
    }

    // Check if selection is within this message's content
    const range = selection.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      return;
    }

    // Get position for popup
    const rect = range.getBoundingClientRect();
    const cardRect = cardRef.current?.getBoundingClientRect();
    if (!cardRect) return;

    setSelectionPopup({
      show: true,
      x: rect.left + rect.width / 2 - cardRect.left,
      y: rect.top - cardRect.top - 10,
      text: selectedText,
    });
  }, []);

  // Hide popup when clicking elsewhere
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (selectionPopup.show) {
        const target = e.target as HTMLElement;
        if (!target.closest('.selection-popup')) {
          setSelectionPopup(prev => ({ ...prev, show: false }));
        }
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selectionPopup.show]);

  // Helper to check if a search field applies to message content (not reasoning)
  const fieldAppliesToContent = (field: SearchField): boolean => {
    switch (field) {
      case 'chat':
      case 'all':
        return true;
      case 'system':
        return message.role === 'system';
      case 'user':
        return message.role === 'user';
      case 'assistant':
        return message.role === 'assistant';
      case 'tool':
        return message.role === 'tool';
      case 'reasoning':
        return false; // Reasoning is handled separately
      default:
        return false;
    }
  };

  // Helper to check if a search field applies to reasoning blocks
  const fieldAppliesToReasoning = (field: SearchField): boolean => {
    if (message.role !== 'assistant') return false;
    switch (field) {
      case 'chat':
      case 'all':
      case 'reasoning':
        return true;
      case 'assistant':
        return false; // When searching assistant specifically, exclude reasoning
      default:
        return false;
    }
  };

  // Get search terms that should be highlighted in content/reasoning
  const getApplicableSearchTerms = useMemo(() => {
    return (isReasoning: boolean): string[] => {
      return searchConditions
        .filter(c => c.operator === 'contains' && c.term.trim())
        .filter(c => isReasoning ? fieldAppliesToReasoning(c.field) : fieldAppliesToContent(c.field))
        .map(c => c.term.trim());
    };
  }, [searchConditions, message.role]);

  // Function to highlight search terms in text
  const highlightSearchAndUrl = useMemo(() => {
    return (text: string, isReasoning: boolean = false): React.ReactNode => {
      // Priority 1: URL highlight (from shareable links)
      if (highlightedText && text.includes(highlightedText)) {
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let matchIndex = text.indexOf(highlightedText);

        while (matchIndex !== -1) {
          if (matchIndex > lastIndex) {
            parts.push(text.slice(lastIndex, matchIndex));
          }
          parts.push(
            <mark
              key={`url-${matchIndex}`}
              className="bg-blue-300 text-blue-900 px-0.5 rounded animate-pulse"
              onClick={onClearHighlight}
              title="Click to clear highlight"
              style={{ cursor: 'pointer' }}
            >
              {text.slice(matchIndex, matchIndex + highlightedText.length)}
            </mark>
          );
          lastIndex = matchIndex + highlightedText.length;
          matchIndex = text.indexOf(highlightedText, lastIndex);
        }

        if (lastIndex < text.length) {
          parts.push(text.slice(lastIndex));
        }

        return parts.length > 0 ? parts : text;
      }

      // Priority 2: Grade quotes (from LLM grading) - purple highlight
      if (gradeQuotes.length > 0) {
        const quotesForThisMessage = gradeQuotes.filter(q => q.message_index === index);
        if (quotesForThisMessage.length > 0) {
          const parts: React.ReactNode[] = [];
          let lastIndex = 0;
          
          // Sort quotes by start position
          const sortedQuotes = [...quotesForThisMessage].sort((a, b) => a.start - b.start);
          
          for (const quote of sortedQuotes) {
            if (quote.start < lastIndex) continue; // Skip overlapping
            if (quote.start > text.length || quote.end > text.length) continue; // Skip invalid ranges
            
            if (quote.start > lastIndex) {
              parts.push(text.slice(lastIndex, quote.start));
            }
            
            parts.push(
              <mark
                key={`quote-${quote.start}`}
                className="bg-purple-200 dark:bg-purple-900/50 text-purple-900 dark:text-purple-200 px-0.5 rounded border-b-2 border-purple-400"
                title="Quoted by LLM grader"
              >
                {text.slice(quote.start, quote.end)}
              </mark>
            );
            lastIndex = quote.end;
          }
          
          if (lastIndex < text.length) {
            parts.push(text.slice(lastIndex));
          }
          
          if (parts.length > 0) {
            return parts;
          }
        }
      }

      // Priority 3: Local search (within this chat) - green highlight
      if (localSearchTerm && localSearchTerm.trim() !== '') {
        const term = localSearchTerm.toLowerCase();
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        const textLower = text.toLowerCase();
        let matchIndex = textLower.indexOf(term, lastIndex);

        while (matchIndex !== -1) {
          if (matchIndex > lastIndex) {
            parts.push(text.slice(lastIndex, matchIndex));
          }
          parts.push(
            <mark
              key={`local-${matchIndex}`}
              className={`px-0.5 rounded ${isCurrentLocalMatch ? 'bg-green-400 text-green-900' : 'bg-green-200 text-green-800'}`}
            >
              {text.slice(matchIndex, matchIndex + localSearchTerm.length)}
            </mark>
          );
          lastIndex = matchIndex + localSearchTerm.length;
          matchIndex = textLower.indexOf(term, lastIndex);
        }

        if (lastIndex < text.length) {
          parts.push(text.slice(lastIndex));
        }

        return parts.length > 0 ? parts : text;
      }

      // Priority 4: Global search terms (from left panel) - yellow highlight, current = orange
      const applicableTerms = getApplicableSearchTerms(isReasoning);
      if (applicableTerms.length === 0) {
        return text;
      }

      // Build a list of all match positions
      const matches: { start: number; end: number; term: string }[] = [];
      const textLower = text.toLowerCase();
      
      applicableTerms.forEach(term => {
        const termLower = term.toLowerCase();
        let searchIndex = 0;
        let matchIndex = textLower.indexOf(termLower, searchIndex);
        
        while (matchIndex !== -1) {
          matches.push({
            start: matchIndex,
            end: matchIndex + term.length,
            term: text.slice(matchIndex, matchIndex + term.length)
          });
          searchIndex = matchIndex + term.length;
          matchIndex = textLower.indexOf(termLower, searchIndex);
        }
      });

      if (matches.length === 0) {
        return text;
      }

      // Sort matches by position and merge overlapping
      matches.sort((a, b) => a.start - b.start);
      
      const parts: React.ReactNode[] = [];
      let lastIndex = 0;
      let occurrenceIdx = 0; // Track occurrence within this message

      matches.forEach((match) => {
        if (match.start < lastIndex) return; // Skip overlapping
        
        if (match.start > lastIndex) {
          parts.push(text.slice(lastIndex, match.start));
        }
        
        // Calculate global occurrence index for this match
        const globalIdx = messageOccurrenceStart + occurrenceIdx;
        const isCurrent = globalIdx === currentOccurrenceIndex;
        
        parts.push(
          <mark
            key={`global-${occurrenceIdx}-${match.start}`}
            className={`px-0.5 rounded global-search-highlight ${
              isCurrent 
                ? 'bg-orange-400 text-orange-950 ring-2 ring-orange-500 ring-offset-1' 
                : 'bg-yellow-300 text-yellow-900'
            }`}
          >
            {match.term}
          </mark>
        );
        lastIndex = match.end;
        occurrenceIdx++;
      });

      if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
      }

      return parts.length > 0 ? parts : text;
    };
  }, [searchConditions, getApplicableSearchTerms, localSearchTerm, isCurrentLocalMatch, highlightedText, onClearHighlight, messageOccurrenceStart, currentOccurrenceIndex, gradeQuotes, index]);

  // Parse reasoning from assistant messages
  const parseContent = (content: string) => {
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
    const reasoningMatch = content.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
    
    const reasoning = thinkMatch?.[1] || reasoningMatch?.[1] || null;
    
    let mainContent = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '')
      .trim();
    
    return { reasoning, mainContent };
  };

  const { reasoning, mainContent } = message.role === 'assistant' 
    ? parseContent(message.content) 
    : { reasoning: null, mainContent: message.content };

  const copyMessageLink = () => {
    const link = generateLink({
      file: filePath,
      rollout: rolloutN,
      message: index,
    });
    navigator.clipboard.writeText(link);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const copySelectionLink = () => {
    const link = generateLink({
      file: filePath,
      rollout: rolloutN,
      message: index,
      highlight: selectionPopup.text,
    });
    navigator.clipboard.writeText(link);
    setCopiedSelection(true);
    setTimeout(() => {
      setCopiedSelection(false);
      setSelectionPopup(prev => ({ ...prev, show: false }));
    }, 1500);
  };

  const textPrimary = isDarkMode ? 'text-gray-200' : 'text-gray-900';
  const textSecondary = isDarkMode ? 'text-gray-300' : 'text-gray-800';
  const textMuted = isDarkMode ? 'text-gray-400' : 'text-gray-600';

  return (
    <div 
      ref={cardRef} 
      className={`transition-all duration-200 relative ${isHighlighted ? 'ring-2 ring-blue-500 ring-offset-2 rounded-lg' : ''}`}
    >
      <div className="relative">
        <div className={`rounded-lg border-l-4 overflow-hidden transition-all duration-200 ${config.className} shadow-md`}>
          {/* Header */}
          <div className={`shadow-xs ${config.headerClassName}`}>
            <div 
              className={`flex items-center justify-between pl-2 pr-1 py-1 cursor-pointer transition-colors duration-150 ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-gray-50/50'}`}
              onClick={() => setIsExpanded(!isExpanded)}
            >
              <div className="flex items-center gap-2">
                <button>
                  <span 
                    className={`material-symbols-outlined ${textMuted} transition-transform duration-200 p-2 -m-2 ${isExpanded ? '' : '-rotate-90'}`} 
                    style={{ fontSize: 17 }}
                  >
                    expand_less
                  </span>
                </button>
                <span className={`font-medium text-sm ${textSecondary}`}>
                  <span className="flex items-center h-5 gap-1">
                    <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                      {config.icon}
                    </span>
                    {message.role}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <button 
                    className={`rounded-md w-6 h-6 focus:outline-none focus:ring-4 flex justify-center items-center ${config.buttonClassName} shadow-md shadow-black/20 relative`}
                    title="Copy link to this message"
                    onClick={(e) => { e.stopPropagation(); copyMessageLink(); }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                      {copiedLink ? 'check' : 'link'}
                    </span>
                  </button>
                  <button 
                    className={`rounded-md w-6 h-6 focus:outline-none focus:ring-4 flex justify-center items-center ${config.buttonClassName} shadow-md shadow-black/20`}
                    title="Remove this and all subsequent messages"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>cut</span>
                  </button>
                  <button 
                    className={`rounded-md w-6 h-6 focus:outline-none focus:ring-4 flex justify-center items-center ${config.buttonClassName} shadow-md shadow-black/20`}
                    title="Edit message"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>edit</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Content */}
          <div 
            className={`grid transition-all duration-300 ease-in-out ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            style={{ overflowWrap: 'anywhere' }}
          >
            <div className="overflow-hidden">
              <div 
                ref={contentRef}
                className="space-y-3 py-3"
                onMouseUp={handleMouseUp}
              >
                {/* Reasoning block */}
                {reasoning && (
                  <div className="mx-3 rounded-md border-l-4 shadow-xs overflow-hidden reasoning">
                    <div className={`px-2 py-1 flex items-center gap-1 text-sm font-medium ${textSecondary} shadow-2xs reasoning-header`}>
                      <span className="material-symbols-outlined" style={{ fontSize: 20 }}>lightbulb</span>
                      reasoning
                    </div>
                    <div className={`px-2 py-1 text-sm ${textPrimary} whitespace-pre-wrap`}>
                      {highlightSearchAndUrl(reasoning, true)}
                    </div>
                  </div>
                )}

                {/* Main content */}
                <div className={`mx-3 whitespace-pre-wrap text-sm ${textPrimary}`}>
                  {highlightSearchAndUrl(mainContent, false)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Selection popup for copying link with highlight */}
        {selectionPopup.show && (
          <div 
            className={`selection-popup absolute z-50 transform -translate-x-1/2 -translate-y-full flex items-center gap-1 px-2 py-1 rounded-lg shadow-lg ${
              isDarkMode ? 'bg-gray-800 border border-gray-600' : 'bg-white border border-gray-300'
            }`}
            style={{ 
              left: selectionPopup.x, 
              top: selectionPopup.y,
            }}
          >
            <button
              onClick={copySelectionLink}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                isDarkMode 
                  ? 'text-blue-400 hover:bg-gray-700' 
                  : 'text-blue-600 hover:bg-blue-50'
              }`}
              title="Copy link with highlighted text"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                {copiedSelection ? 'check' : 'link'}
              </span>
              {copiedSelection ? 'Copied!' : 'Copy link'}
            </button>
            <div className={`w-px h-4 ${isDarkMode ? 'bg-gray-600' : 'bg-gray-300'}`} />
            <button
              onClick={() => setSelectionPopup(prev => ({ ...prev, show: false }))}
              className={`p-1 rounded transition-colors ${
                isDarkMode 
                  ? 'text-gray-400 hover:bg-gray-700' 
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
              title="Close"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
            </button>
            {/* Arrow */}
            <div 
              className={`absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 ${
                isDarkMode 
                  ? 'border-l-transparent border-r-transparent border-t-gray-800' 
                  : 'border-l-transparent border-r-transparent border-t-white'
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
