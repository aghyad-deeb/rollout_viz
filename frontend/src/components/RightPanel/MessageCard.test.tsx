import { render, screen, fireEvent } from '@testing-library/react';
import { MessageCard } from './MessageCard';

// jsdom does not implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const defaultProps = {
  message: { role: 'user' as const, content: 'Hello world' },
  index: 0,
  searchConditions: [],
  isDarkMode: false,
  rolloutN: 0,
  filePath: 'test.jsonl',
  generateLink: vi.fn(() => 'http://test/link'),
  isHighlighted: false,
  highlightedText: null,
  onClearHighlight: vi.fn(),
  messageOccurrenceStart: 0,
  currentOccurrenceIndex: -1,
};

describe('MessageCard', () => {
  it('renders message content', () => {
    render(<MessageCard {...defaultProps} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('displays correct role label', () => {
    render(<MessageCard {...defaultProps} />);
    expect(screen.getByText('user')).toBeInTheDocument();
  });

  it('renders system role', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'system', content: 'System prompt' }} />);
    expect(screen.getByText('system')).toBeInTheDocument();
    expect(screen.getByText('System prompt')).toBeInTheDocument();
  });

  it('renders assistant role', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'assistant', content: 'I can help' }} />);
    expect(screen.getByText('assistant')).toBeInTheDocument();
    expect(screen.getByText('I can help')).toBeInTheDocument();
  });

  it('renders tool role', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'tool', content: 'Tool output' }} />);
    expect(screen.getByText('tool')).toBeInTheDocument();
  });

  it('extracts think tags from assistant content', () => {
    const message = { role: 'assistant' as const, content: '<think>internal reasoning</think>Main response' };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('internal reasoning')).toBeInTheDocument();
    expect(screen.getByText('Main response')).toBeInTheDocument();
  });

  it('extracts reasoning tags from assistant content', () => {
    const message = { role: 'assistant' as const, content: '<reasoning>step by step</reasoning>Final answer' };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('step by step')).toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();
  });

  it('highlights URL text with blue', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'Find the word hello in this text' }}
      highlightedText="hello"
      isHighlighted={true}
    />);
    const mark = screen.getByText('hello');
    expect(mark.tagName).toBe('MARK');
    expect(mark.className).toContain('blue');
  });

  it('highlights local search with green', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'Hello world' }}
      localSearchTerm="world"
    />);
    const mark = screen.getByText('world');
    expect(mark.tagName).toBe('MARK');
    expect(mark.className).toContain('green');
  });

  it('highlights grade quotes with purple', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'This is important text here' }}
      gradeQuotes={[{ message_index: 0, start: 8, end: 17, text: 'important' }]}
    />);
    const mark = screen.getByText('important');
    expect(mark.tagName).toBe('MARK');
    expect(mark.className).toContain('purple');
  });

  it('collapses and expands on header click', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'user', content: 'Collapsible content' }} />);
    // Content should be visible initially
    expect(screen.getByText('Collapsible content')).toBeInTheDocument();

    // Click the header to collapse
    const header = screen.getByText('user').closest('[class*="cursor-pointer"]');
    if (header) fireEvent.click(header);

    // The grid-rows class should change to 0fr when collapsed
    const contentWrapper = screen.getByText('Collapsible content').closest('[class*="grid"]');
    expect(contentWrapper?.className).toContain('grid-rows-[0fr]');
  });

  it('shows ring highlight when isHighlighted is true', () => {
    const { container } = render(<MessageCard {...defaultProps} isHighlighted={true} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('ring-2');
  });

  it('is wrapped in React.memo', () => {
    // React.memo components have $$typeof === Symbol.for('react.memo')
    expect(MessageCard).toHaveProperty('$$typeof', Symbol.for('react.memo'));
  });

  it('re-renders 100x with same props in under 100ms', () => {
    const { rerender } = render(<MessageCard {...defaultProps} />);
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      rerender(<MessageCard {...defaultProps} />);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
