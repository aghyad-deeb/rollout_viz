import { render, screen } from '@testing-library/react';
import { ChatView } from './ChatView';
import type { Sample, SampleGrades } from '../../types';

// Mock MessageCard to render a simple representation of each message
vi.mock('./MessageCard', () => ({
  MessageCard: ({ message, index }: { message: { role: string; content: string }; index: number }) => (
    <div data-testid={`message-${index}`}>
      <span data-testid={`role-${index}`}>{message.role}</span>
      <span data-testid={`content-${index}`}>{message.content}</span>
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
