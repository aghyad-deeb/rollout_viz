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

  it('strips Kimi ChatML tokens from assistant content', () => {
    const message = {
      role: 'assistant' as const,
      content: '<|im_assistant|>assistant<|im_middle|><think></think> The answer is 42.<|im_end|>',
    };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('The answer is 42.')).toBeInTheDocument();
    expect(screen.queryByText(/im_assistant/)).not.toBeInTheDocument();
    expect(screen.queryByText(/im_end/)).not.toBeInTheDocument();
  });

  it('renders inline Kimi tool calls in a tool-call panel', () => {
    const message = {
      role: 'assistant' as const,
      content:
        '<|im_assistant|>assistant<|im_middle|><think></think> Checking ' +
        '<|tool_calls_section_begin|><|tool_call_begin|>functions.bash:0' +
        '<|tool_call_argument_begin|>{"command": "ls"}<|tool_call_end|>' +
        '<|tool_calls_section_end|><|im_end|>',
    };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('tool call')).toBeInTheDocument();
  });

  it('extracts redacted_thinking tags', () => {
    const message = {
      role: 'assistant' as const,
      content: '<redacted_thinking>hidden plan</redacted_thinking>Public answer',
    };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('hidden plan')).toBeInTheDocument();
    expect(screen.getByText('Public answer')).toBeInTheDocument();
  });

  it('prefers content_parts over raw content', () => {
    const message = {
      role: 'assistant' as const,
      content: 'raw noisy content',
      content_parts: [
        { type: 'thinking' as const, thinking: 'structured thinking' },
        { type: 'text' as const, text: 'clean answer' },
      ],
    };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('structured thinking')).toBeInTheDocument();
    expect(screen.getByText('clean answer')).toBeInTheDocument();
    expect(screen.queryByText('raw noisy content')).not.toBeInTheDocument();
  });
});
