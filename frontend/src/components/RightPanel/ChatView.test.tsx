import { render, screen, fireEvent } from '@testing-library/react';
import { ChatView } from './ChatView';
import type { Sample, SampleGrades } from '../../types';

// Mock MessageCard to render a simple representation of each message.
// Exposes an `add-highlight-<index>` button so tests can simulate the
// selection-popup "Highlight" click without wiring the real selection API.
vi.mock('./MessageCard', () => ({
  MessageCard: ({
    message,
    index,
    onAddEphemeralHighlight,
  }: {
    message: { role: string; content: string };
    index: number;
    onAddEphemeralHighlight?: (messageIndex: number, text: string) => void;
  }) => (
    <div data-testid={`message-${index}`}>
      <span data-testid={`role-${index}`}>{message.role}</span>
      <span data-testid={`content-${index}`}>{message.content}</span>
      <button
        data-testid={`add-highlight-${index}`}
        onClick={() => onAddEphemeralHighlight?.(index, `hl-${index}`)}
      >
        add-highlight
      </button>
    </div>
  ),
}));

// Mock GradesDisplay to render a visible indicator when grades are present
vi.mock('./GradesDisplay', () => ({
  GradesDisplay: ({ grades }: { grades: SampleGrades | undefined }) => {
    if (!grades || Object.keys(grades).length === 0) return null;
    return (
      <div data-testid="grades-display">
        {Object.keys(grades).map((metric) => (
          <span key={metric} data-testid={`grade-metric-${metric}`}>{metric}</span>
        ))}
      </div>
    );
  },
}));

function makeSample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: 1,
    messages: [
      { role: 'user', content: 'Hello, how are you?' },
      { role: 'assistant', content: 'I am doing well, thank you!' },
    ],
    attributes: {
      step: 100,
      sample_index: 0,
      rollout_n: 1,
      reward: 0.5,
      data_source: 'test/source',
      experiment_name: 'test_exp',
      is_validate: false,
    },
    timestamp: '2026-01-15T10:00:00',
    ...overrides,
  };
}

const defaultProps = {
  sample: makeSample(),
  searchConditions: [],
  currentOccurrenceIndex: -1,
  isDarkMode: false,
  filePath: 'test.jsonl',
  generateLink: vi.fn(() => 'http://test/link'),
  highlightedMessageIndex: null,
  highlightedText: null,
  onClearHighlight: vi.fn(),
};

describe('ChatView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all messages', () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.getByTestId('message-0')).toBeInTheDocument();
    expect(screen.getByTestId('message-1')).toBeInTheDocument();
  });

  it('renders correct message content', () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.getByTestId('content-0')).toHaveTextContent('Hello, how are you?');
    expect(screen.getByTestId('content-1')).toHaveTextContent('I am doing well, thank you!');
  });

  it('renders correct message roles', () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.getByTestId('role-0')).toHaveTextContent('user');
    expect(screen.getByTestId('role-1')).toHaveTextContent('assistant');
  });

  it('renders multiple messages in a longer conversation', () => {
    const sample = makeSample({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: 'The answer is 4.' },
        { role: 'user', content: 'Thanks!' },
        { role: 'assistant', content: 'You are welcome!' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    expect(screen.getByTestId('message-0')).toBeInTheDocument();
    expect(screen.getByTestId('message-1')).toBeInTheDocument();
    expect(screen.getByTestId('message-2')).toBeInTheDocument();
    expect(screen.getByTestId('message-3')).toBeInTheDocument();
    expect(screen.getByTestId('message-4')).toBeInTheDocument();
    expect(screen.getByTestId('content-0')).toHaveTextContent('You are a helpful assistant.');
    expect(screen.getByTestId('content-4')).toHaveTextContent('You are welcome!');
  });

  it('handles empty messages array', () => {
    const sample = makeSample({ messages: [] });
    const { container } = render(<ChatView {...defaultProps} sample={sample} />);
    // No message elements should be rendered
    expect(screen.queryByTestId('message-0')).not.toBeInTheDocument();
    // The component should still render its container structure
    expect(container.firstChild).toBeInTheDocument();
  });

  it('displays grades section when grades are present', () => {
    const grades: SampleGrades = {
      helpfulness: [
        {
          grade: 0.85,
          grade_type: 'float',
          quotes: [],
          explanation: 'Helpful response.',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    const sample = makeSample({ grades });
    render(<ChatView {...defaultProps} sample={sample} />);
    expect(screen.getByTestId('grades-display')).toBeInTheDocument();
    expect(screen.getByTestId('grade-metric-helpfulness')).toHaveTextContent('helpfulness');
  });

  it('displays multiple grade metrics', () => {
    const grades: SampleGrades = {
      helpfulness: [
        {
          grade: 0.9,
          grade_type: 'float',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
      safety: [
        {
          grade: true,
          grade_type: 'bool',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    const sample = makeSample({ grades });
    render(<ChatView {...defaultProps} sample={sample} />);
    expect(screen.getByTestId('grade-metric-helpfulness')).toBeInTheDocument();
    expect(screen.getByTestId('grade-metric-safety')).toBeInTheDocument();
  });

  it('does not display grades section when sample has no grades', () => {
    const sample = makeSample({ grades: undefined });
    render(<ChatView {...defaultProps} sample={sample} />);
    expect(screen.queryByTestId('grades-display')).not.toBeInTheDocument();
  });

  it('renders sample metadata in the footer', () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.getByText('Step:')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('Reward:')).toBeInTheDocument();
    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(screen.getByText('Rollout:')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Source:')).toBeInTheDocument();
    expect(screen.getByText('test/source')).toBeInTheDocument();
    expect(screen.getByText('Timestamp:')).toBeInTheDocument();
    expect(screen.getByText('2026-01-15T10:00:00')).toBeInTheDocument();
  });

  it('shows search chat button when search is not open', () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.getByText('Search chat')).toBeInTheDocument();
  });

  it('shows no highlight count + clear button when there are no ephemeral highlights', () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.queryByTitle(/Clear all highlights/)).not.toBeInTheDocument();
  });

  it('shows count + clear button after adding an ephemeral highlight', () => {
    render(<ChatView {...defaultProps} />);
    fireEvent.click(screen.getByTestId('add-highlight-0'));
    expect(screen.getByTitle(/Clear all highlights/)).toBeInTheDocument();
  });

  it('Clear button removes all ephemeral highlights', () => {
    render(<ChatView {...defaultProps} />);
    fireEvent.click(screen.getByTestId('add-highlight-0'));
    fireEvent.click(screen.getByTestId('add-highlight-1'));
    expect(screen.getByTitle(/Clear all highlights/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/Clear all highlights/));
    expect(screen.queryByTitle(/Clear all highlights/)).not.toBeInTheDocument();
  });

  it('clears ephemeral highlights when the user navigates to a different sample', () => {
    const { rerender } = render(<ChatView {...defaultProps} />);
    fireEvent.click(screen.getByTestId('add-highlight-0'));
    expect(screen.getByTitle(/Clear all highlights/)).toBeInTheDocument();

    // Swap in a different sample — ephemeral highlights are sample-scoped.
    rerender(<ChatView {...defaultProps} sample={makeSample({ id: 999 })} />);
    expect(screen.queryByTitle(/Clear all highlights/)).not.toBeInTheDocument();
  });

  it('colors positive reward green and negative reward red', () => {
    const positiveSample = makeSample({
      attributes: {
        step: 0,
        sample_index: 0,
        rollout_n: 0,
        reward: 1.5,
        data_source: 'test',
        experiment_name: 'test',
        is_validate: false,
      },
    });
    const { rerender } = render(<ChatView {...defaultProps} sample={positiveSample} />);
    const positiveReward = screen.getByText('1.5');
    expect(positiveReward.className).toContain('text-green-600');

    const negativeSample = makeSample({
      attributes: {
        step: 0,
        sample_index: 0,
        rollout_n: 0,
        reward: -0.5,
        data_source: 'test',
        experiment_name: 'test',
        is_validate: false,
      },
    });
    rerender(<ChatView {...defaultProps} sample={negativeSample} />);
    const negativeReward = screen.getByText('-0.5');
    expect(negativeReward.className).toContain('text-red-600');
  });
});

// ---------------------------------------------------------------------------
// Local Ctrl+F search — corpus-based behavior
// ---------------------------------------------------------------------------
//
// These tests drive the search input directly and assert the count
// indicator that ChatView renders next to it (`N/M` or `No matches`).
// Since the count comes from `localMatches`, which is fed by
// `buildSearchCorpus(message)`, asserting on the count proves the
// corpus is the source of truth for the search.

describe('ChatView local search corpus', () => {
  function openSearch() {
    // jsdom doesn't bubble synthetic KeyboardEvents through the window-level
    // listener consistently, so we click the visible "Search chat" button —
    // it triggers the same setIsSearchOpen(true) as the Ctrl+F binding.
    fireEvent.click(screen.getByText('Search chat'));
  }
  function typeSearch(term: string) {
    const input = screen.getByPlaceholderText('Search in this chat...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: term } });
  }

  it('finds text inside content_parts.thinking when message.content is empty', () => {
    // The previous searcher read message.content directly and missed
    // anything that lived only in content_parts.
    const sample = makeSample({
      messages: [
        {
          role: 'assistant',
          content: '',
          content_parts: [
            { type: 'thinking', thinking: 'XYZ-only-in-thinking-parts' },
            { type: 'text', text: 'visible answer' },
          ],
        },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    openSearch();
    typeSearch('XYZ-only-in-thinking-parts');
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('finds text inside structured tool_calls function name', () => {
    const sample = makeSample({
      messages: [
        {
          role: 'assistant',
          content: 'running shell',
          tool_calls: [{ type: 'function', function: { name: 'find_file_xyz', arguments: '{}' } }],
        },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    openSearch();
    typeSearch('find_file_xyz');
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('finds text inside structured tool_calls arguments', () => {
    const sample = makeSample({
      messages: [
        {
          role: 'assistant',
          content: 'running shell',
          tool_calls: [
            {
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"grep XYZ-target /etc/hosts"}' },
            },
          ],
        },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    openSearch();
    typeSearch('XYZ-target');
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('does NOT match ChatML marker tokens the renderer strips', () => {
    // Inverse-miss prevention: searches for invisible-to-the-user marker
    // text should report no matches.
    const sample = makeSample({
      messages: [
        {
          role: 'assistant',
          content: '<|im_assistant|>assistant<|im_middle|>The answer is 42.<|im_end|>',
        },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    openSearch();
    typeSearch('im_assistant');
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('matches across U+202F vs U+0020 whitespace mismatch', () => {
    // Corpus retains U+202F; query uses ASCII space; findAllMatchesCI
    // normalizes both before comparing.
    const sample = makeSample({
      messages: [
        { role: 'user', content: 'meeting at 7 am in office' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    openSearch();
    typeSearch('7 am');
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('matches text that lives in main content (regression)', () => {
    // Sanity: the original happy path still works.
    render(<ChatView {...defaultProps} />);
    openSearch();
    typeSearch('how are you');
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('counts a term that occurs once in content and once in tool_calls', () => {
    const sample = makeSample({
      messages: [
        {
          role: 'assistant',
          content: 'use grep for this',
          tool_calls: [
            { type: 'function', function: { name: 'bash', arguments: '{"command":"grep foo"}' } },
          ],
        },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    openSearch();
    typeSearch('grep');
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });
});
