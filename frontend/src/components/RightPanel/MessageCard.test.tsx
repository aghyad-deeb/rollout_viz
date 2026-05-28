import { useState, type ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageCard } from './MessageCard';

// The tool-call wrap toggle is controlled by lifted state (so the off-screen
// capture card mirrors it). This harness supplies that state locally so the
// wrap-toggle tests can still exercise the click → re-render path.
function WrapHarness(props: ComponentProps<typeof MessageCard>) {
  const [wrapped, setWrapped] = useState<Set<string>>(new Set());
  return (
    <MessageCard
      {...props}
      wrappedToolCalls={wrapped}
      onToggleToolCallWrap={(mi, ti) => setWrapped((prev) => {
        const next = new Set(prev);
        const k = `${mi}:${ti}`;
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      })}
    />
  );
}

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

  it('renders file role with a file icon and display name', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'file', content: 'File preview', name: 'slides/input.jsonl' }} />);
    expect(screen.getByText('description')).toBeInTheDocument();
    expect(screen.getByText('slides/input.jsonl')).toBeInTheDocument();
    expect(screen.getByText('File preview')).toBeInTheDocument();
  });

  it('renders a presentation label in place of the raw role', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'assistant', content: 'Model answer', presentationLabel: 'GPT-5.1' }} />);
    expect(screen.getByText('GPT-5.1')).toBeInTheDocument();
    expect(screen.queryByText('assistant')).not.toBeInTheDocument();
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
    // ChatView's scroll-to-quote effect targets this class — keep it in sync.
    expect(mark.className).toContain('url-highlight-mark');
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

  it('matches grade quotes across Unicode whitespace mismatches (LLM normalized U+202F → space)', () => {
    // Regression: Claude Opus 4.6 echoed a quote from a message that contained
    // U+202F NARROW NO-BREAK SPACE as regular ASCII space, so the old
    // `text.indexOf(quote.text)` failed and no purple mark rendered.
    // Content keeps the original U+202F; quote.text uses ASCII space.
    const content = 'core hours 7\u202Fam\u20137\u202Fpm';
    const quoteText = 'core hours 7 am–7 pm'; // regular spaces
    render(<MessageCard {...defaultProps}
      message={{ role: 'tool', content }}
      gradeQuotes={[{ message_index: 0, start: 0, end: content.length, text: quoteText }]}
    />);
    // A mark should render, and its text should be the ORIGINAL content
    // (with U+202F preserved) — not the normalized quote text.
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    const purpleMark = Array.from(marks).find(m => m.className.includes('purple'));
    expect(purpleMark).toBeDefined();
    expect(purpleMark!.textContent).toContain('\u202F'); // original whitespace preserved
    // Carries the scroll-target class so ChatView's prev/next can find it.
    expect(purpleMark!.className).toContain('grade-quote-mark');
  });

  it('highlights ephemeral session highlights with fuchsia', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'keep this phrase marked' }}
      ephemeralHighlights={[{ id: 'h1', messageIndex: 0, text: 'this phrase' }]}
    />);
    const mark = screen.getByText('this phrase');
    expect(mark.tagName).toBe('MARK');
    expect(mark.className).toContain('fuchsia');
  });

  it('renders an ephemeral bold format as <strong>', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'make this phrase bold' }}
      ephemeralHighlights={[{ id: 'b1', messageIndex: 0, text: 'this phrase', style: 'bold' }]}
    />);
    const strong = screen.getByText('this phrase');
    expect(strong.tagName).toBe('STRONG');
    expect(strong.className).toContain('ephemeral-bold-mark');
  });

  it('renders an ephemeral italic format as <em>', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'make this phrase italic' }}
      ephemeralHighlights={[{ id: 'i1', messageIndex: 0, text: 'this phrase', style: 'italic' }]}
    />);
    const em = screen.getByText('this phrase');
    expect(em.tagName).toBe('EM');
    expect(em.className).toContain('ephemeral-italic-mark');
  });

  it('removes ephemeral highlight on click via callback', () => {
    const onRemove = vi.fn();
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'hello marker world' }}
      ephemeralHighlights={[{ id: 'h42', messageIndex: 0, text: 'marker' }]}
      onRemoveEphemeralHighlight={onRemove}
    />);
    fireEvent.click(screen.getByText('marker'));
    expect(onRemove).toHaveBeenCalledWith('h42');
  });

  it('ephemeral highlights only apply to their own message (messageIndex match)', () => {
    render(<MessageCard {...defaultProps}
      index={2}
      message={{ role: 'user', content: 'keep this phrase marked' }}
      ephemeralHighlights={[{ id: 'h1', messageIndex: 5, text: 'this phrase' }]}
    />);
    // messageIndex (5) doesn't match index (2) — no <mark> should render
    const candidate = screen.getByText('keep this phrase marked');
    expect(candidate.tagName).not.toBe('MARK');
  });

  it('URL-share highlight outranks ephemeral when both match the same text', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'the shared passage lives here' }}
      isHighlighted={true}
      highlightedText="shared passage"
      ephemeralHighlights={[{ id: 'h1', messageIndex: 0, text: 'shared passage' }]}
    />);
    const mark = screen.getByText('shared passage');
    // Priority 1 (URL blue) must win — verifies ephemeral is priority 2, not 1.
    expect(mark.className).toContain('blue');
    expect(mark.className).not.toContain('fuchsia');
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
    expect(screen.getByText('bash')).toBeInTheDocument();
  });

  it('renders Harmony tool calls in the structured tool card', () => {
    const message = {
      role: 'assistant' as const,
      content:
        '<|channel|>analysis<|message|>Need shell.<|end|>' +
        '<|start|>assistant<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{"command":"pwd"}<|call|>',
    };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('Need shell.')).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('pwd')).toBeInTheDocument();
    expect(screen.queryByText('{"command":"pwd"}')).not.toBeInTheDocument();
  });

  it('renders stored stringified tool_calls as command-only text', () => {
    const message = {
      role: 'assistant' as const,
      content: 'Running shell command',
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command":"ls -la data/"}',
          },
        },
      ],
    };
    render(<MessageCard {...defaultProps} message={message} />);
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('ls -la data/')).toBeInTheDocument();
    expect(screen.queryByText('{"command":"ls -la data/"}')).not.toBeInTheDocument();
  });

  it('copies message text via the new content-copy button', async () => {
    // Mock clipboard for jsdom (which doesn't implement it natively).
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<MessageCard {...defaultProps}
      message={{
        role: 'assistant',
        content: '<think>thinking aloud</think>final answer',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
        ],
      }}
    />);

    // Find the button by its title attribute (most stable handle).
    const buttons = screen.getAllByTitle('Copy message text (reasoning, content, tool calls)');
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      '[Reasoning]\nthinking aloud\n\nfinal answer\n\n[Tool: bash]\npwd'
    );
  });

  it('content-copy button is a no-op for an empty message', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<MessageCard {...defaultProps} message={{ role: 'user', content: '' }} />);
    const button = screen.getByTitle('Copy message text (reasoning, content, tool calls)');
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('tool-call <pre> defaults to overflow-x-auto (no wrap)', () => {
    render(<MessageCard {...defaultProps}
      message={{
        role: 'assistant',
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{"command":"echo hi"}' } },
        ],
      }}
    />);
    const pre = screen.getByTestId('tool-call-pre-0');
    expect(pre.className).toContain('overflow-x-auto');
    expect(pre.className).not.toContain('whitespace-pre-wrap');
  });

  it('clicking the wrap toggle switches the <pre> to wrapped mode', () => {
    render(<WrapHarness {...defaultProps}
      message={{
        role: 'assistant',
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{"command":"a very long line that would normally scroll"}' } },
        ],
      }}
    />);
    const toggle = screen.getByTestId('tool-call-wrap-toggle-0');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const pre = screen.getByTestId('tool-call-pre-0');
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(pre.className).toContain('break-words');
    expect(pre.className).not.toContain('overflow-x-auto');
  });

  it('wrap toggles are independent across multiple tool calls in the same message', () => {
    render(<WrapHarness {...defaultProps}
      message={{
        role: 'assistant',
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{"command":"first"}' } },
          { type: 'function', function: { name: 'bash', arguments: '{"command":"second"}' } },
        ],
      }}
    />);
    fireEvent.click(screen.getByTestId('tool-call-wrap-toggle-0'));
    expect(screen.getByTestId('tool-call-pre-0').className).toContain('whitespace-pre-wrap');
    expect(screen.getByTestId('tool-call-pre-1').className).not.toContain('whitespace-pre-wrap');
  });

  it('clicking the wrap toggle does not bubble up to the card collapse', () => {
    render(<MessageCard {...defaultProps}
      message={{
        role: 'assistant',
        content: 'some content',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{"command":"x"}' } },
        ],
      }}
    />);
    // Card starts expanded; if the wrap-toggle click bubbled, the grid
    // would collapse. Verify the content is still visible after click.
    fireEvent.click(screen.getByTestId('tool-call-wrap-toggle-0'));
    expect(screen.getByText('some content')).toBeInTheDocument();
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

  // --- Presentation Mode: collapse + capture ---

  it('collapses a region into an elision pill in presentation mode', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'keep noise keep' }}
      isPresentationMode={true}
      collapsedRegions={[{ id: 'c1', messageIndex: 0, text: 'noise' }]}
    />);
    expect(screen.getByText('[...]')).toBeInTheDocument();
    // The collapsed word is no longer present as standalone visible text.
    expect(screen.queryByText('keep noise keep')).not.toBeInTheDocument();
  });

  it('a collapsed region joins the lines before and after by default', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'line one\nMIDDLE\nline three' }}
      isPresentationMode={true}
      collapsedRegions={[{ id: 'c1', messageIndex: 0, text: 'MIDDLE' }]}
    />);
    const block = container.querySelector('[data-block-kind="content"]');
    // Newlines flanking the collapsed span are dropped → the pill is inline.
    expect(block?.textContent).toBe('line one [...] line three');
  });

  it('collapsing the whole reasoning renders its [...] inline with the main content', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'assistant', content: '<think>inner reasoning</think>the visible answer' }}
      isPresentationMode={true}
      collapsedRegions={[{ id: 'r1', messageIndex: 0, text: 'inner reasoning' }]}
    />);
    const contentBlock = container.querySelector('[data-block-kind="content"]');
    // The collapsed-whole reasoning [...] lives inside the content block so
    // it shares the line — not in a standalone reasoning block above it.
    expect(contentBlock?.querySelector('.elision-pill')).not.toBeNull();
    expect(contentBlock?.textContent).toContain('the visible answer');
    expect(container.querySelector('[data-block-kind="reasoning"]')).toBeNull();
  });

  it('a located collapse affects only its own block, not the same string elsewhere', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'assistant', content: '<think>the answer is A here</think>A' }}
      isPresentationMode={true}
      collapsedRegions={[{ id: 'c1', messageIndex: 0, text: 'A', locator: { blockKind: 'content', occurrence: 0 } }]}
    />);
    // The content "A" collapses to a pill; the "A" in the reasoning stays
    // intact (the reasoning text renders whole).
    expect(screen.getByText('[...]')).toBeInTheDocument();
    expect(screen.getByText('the answer is A here')).toBeInTheDocument();
  });

  it('a located highlight marks only its own block, not the same string elsewhere', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'assistant', content: '<think>answer A again</think>A' }}
      ephemeralHighlights={[{ id: 'h1', messageIndex: 0, text: 'A', locator: { blockKind: 'content', occurrence: 0 } }]}
    />);
    // Exactly one ephemeral mark — the content "A", not the reasoning "A".
    const marks = container.querySelectorAll('mark.ephemeral-highlight-mark');
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe('A');
  });

  it('ignores collapsedRegions when not in presentation mode', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'keep noise keep' }}
      isPresentationMode={false}
      collapsedRegions={[{ id: 'c1', messageIndex: 0, text: 'noise' }]}
    />);
    expect(screen.queryByText('[...]')).not.toBeInTheDocument();
    expect(screen.getByText('keep noise keep')).toBeInTheDocument();
  });

  it('collapsed regions only apply to their own message index', () => {
    render(<MessageCard {...defaultProps}
      index={3}
      message={{ role: 'user', content: 'keep noise keep' }}
      isPresentationMode={true}
      collapsedRegions={[{ id: 'c1', messageIndex: 9, text: 'noise' }]}
    />);
    expect(screen.queryByText('[...]')).not.toBeInTheDocument();
  });

  it('removing an elision pill calls onRemoveCollapsedRegion with its id', () => {
    const onRemove = vi.fn();
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'keep noise keep' }}
      isPresentationMode={true}
      collapsedRegions={[{ id: 'c1', messageIndex: 0, text: 'noise' }]}
      onRemoveCollapsedRegion={onRemove}
    />);
    // Left click on the pill expands (removes) the collapse.
    fireEvent.click(screen.getByText('[...]'));
    expect(onRemove).toHaveBeenCalledWith('c1');
  });

  it('shows the capture button only in presentation mode', () => {
    const { rerender } = render(<MessageCard {...defaultProps} isPresentationMode={false} />);
    expect(screen.queryByTestId('capture-message-btn')).not.toBeInTheDocument();
    rerender(<MessageCard {...defaultProps} isPresentationMode={true} />);
    expect(screen.getByTestId('capture-message-btn')).toBeInTheDocument();
  });

  it('clicking the capture button calls onCaptureMessage with the message index', () => {
    const onCapture = vi.fn();
    render(<MessageCard {...defaultProps} index={2} isPresentationMode={true} onCaptureMessage={onCapture} />);
    fireEvent.click(screen.getByTestId('capture-message-btn'));
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith(2);
  });
});
