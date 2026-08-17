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
    // System cards start collapsed, so the text appears twice: the hidden
    // body and the header's one-line excerpt.
    expect(screen.getAllByText('System prompt').length).toBeGreaterThan(0);
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

  it('highlights grade quotes with violet (bluer than user-fuchsia highlights)', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'This is important text here' }}
      gradeQuotes={[{ message_index: 0, start: 8, end: 17, text: 'important' }]}
    />);
    const mark = screen.getByText('important');
    expect(mark.tagName).toBe('MARK');
    expect(mark.className).toContain('violet');
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
    const quoteMark = Array.from(marks).find(m => m.className.includes('violet'));
    expect(quoteMark).toBeDefined();
    expect(quoteMark!.textContent).toContain('\u202F'); // original whitespace preserved
    // Carries the scroll-target class so ChatView's prev/next can find it.
    expect(quoteMark!.className).toContain('grade-quote-mark');
  });

  it('matches grade quotes case-insensitively (judge capitalized a mid-sentence excerpt)', () => {
    // Regression: a judge quoted "The final grade is done by LLM monitor…"
    // from a transcript that reads "…But the final grade is done by…" —
    // case-sensitive matching silently dropped the quote (no purple mark)
    // and shifted the quote pager onto the wrong marks.
    const content = 'But the final grade is done by LLM monitor not internal grader.';
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content }}
      gradeQuotes={[{ message_index: 0, start: 4, end: 55, text: 'The final grade is done by LLM monitor not internal' }]}
    />);
    const purpleMark = Array.from(document.querySelectorAll('mark')).find(m => m.className.includes('grade-quote-mark'));
    expect(purpleMark).toBeDefined();
    // Renders the ORIGINAL transcript casing, not the judge's.
    expect(purpleMark!.textContent).toContain('the final grade');
  });

  it('stamps each quote mark with its index in the quote list (data-quote-idx)', () => {
    const content = 'alpha section one. beta section two.';
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content }}
      gradeQuotes={[
        { message_index: 0, start: 0, end: 5, text: 'alpha' },
        { message_index: 0, start: 19, end: 23, text: 'beta' },
      ]}
    />);
    const alpha = screen.getByText('alpha');
    const beta = screen.getByText('beta');
    expect(alpha.getAttribute('data-quote-idx')).toBe('0');
    expect(beta.getAttribute('data-quote-idx')).toBe('1');
  });

  it('keeps quote-idx stamps aligned when an earlier quote cannot be located', () => {
    // The pager targets marks by data-quote-idx, so an unlocatable quote at
    // index 0 must not shift quote 1's mark identity.
    const content = 'only the second quote appears in this transcript.';
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content }}
      gradeQuotes={[
        { message_index: 0, start: 0, end: 10, text: 'THIS TEXT WAS PARAPHRASED BY THE JUDGE' },
        { message_index: 0, start: 9, end: 21, text: 'second quote' },
      ]}
    />);
    expect(document.querySelector('mark[data-quote-idx="0"]')).toBeNull();
    const mark = document.querySelector('mark[data-quote-idx="1"]');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('second quote');
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

  it('composes URL-share and ephemeral highlights on the same text', () => {
    const onClear = vi.fn();
    const onRemove = vi.fn();
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'the shared passage lives here' }}
      isHighlighted={true}
      highlightedText="shared passage"
      onClearHighlight={onClear}
      ephemeralHighlights={[{ id: 'h1', messageIndex: 0, text: 'shared passage' }]}
      onRemoveEphemeralHighlight={onRemove}
    />);
    const mark = screen.getByText('shared passage');
    expect(mark.tagName).toBe('MARK');
    expect(mark.className).toContain('url-highlight-mark');
    expect(mark.className).toContain('ephemeral-highlight-mark');

    fireEvent.click(mark);

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('h1');
  });

  it('composes bold, grade quote, local search, and global search when ranges overlap', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'alpha target phrase omega' }}
      gradeQuotes={[{ message_index: 0, start: 6, end: 12, text: 'target' }]}
      ephemeralHighlights={[{ id: 'b1', messageIndex: 0, text: 'target phrase', style: 'bold' }]}
      localSearchTerm="target phrase"
      searchConditions={[{ id: 's1', field: 'chat', operator: 'contains', term: 'target phrase' }]}
    />);

    const firstSegment = container.querySelector('mark.grade-quote-mark');
    expect(firstSegment).not.toBeNull();
    expect(firstSegment!.textContent).toBe('target');
    expect(firstSegment!.className).toContain('local-search-mark');
    expect(firstSegment!.className).toContain('global-search-highlight');
    expect(firstSegment!.querySelector('strong.ephemeral-bold-mark')).not.toBeNull();

    const secondSegment = container.querySelector('mark.local-search-fragment.global-search-highlight-fragment');
    expect(secondSegment).not.toBeNull();
    expect(secondSegment!.textContent).toBe(' phrase');
    expect(secondSegment!.querySelector('strong.ephemeral-bold-mark')).not.toBeNull();
  });

  it('composes reasoning highlights and keeps thinking quotes in the reasoning block', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'assistant', content: '<think>internal reasoning phrase</think>Visible answer' }}
      gradeQuotes={[{ message_index: 0, channel: 'thinking', start: 9, end: 25, text: 'reasoning phrase' }]}
      ephemeralHighlights={[{
        id: 'h1',
        messageIndex: 0,
        text: 'reasoning phrase',
        locator: { blockKind: 'reasoning', occurrence: 0 },
      }]}
      localSearchTerm="reasoning phrase"
      searchConditions={[{ id: 's1', field: 'reasoning', operator: 'contains', term: 'reasoning phrase' }]}
    />);

    const reasoningBlock = container.querySelector('[data-block-kind="reasoning"]');
    const mark = reasoningBlock?.querySelector('mark.grade-quote-mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('reasoning phrase');
    expect(mark!.className).toContain('ephemeral-highlight-mark');
    expect(mark!.className).toContain('local-search-mark');
    expect(mark!.className).toContain('global-search-highlight');
    expect(container.querySelector('[data-block-kind="content"] mark.grade-quote-mark')).toBeNull();
  });

  it('highlights legacy text quotes inside rendered Harmony reasoning blocks', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{
        role: 'assistant',
        content: '<|channel|>analysis<|message|>We need to adapt to pass their asserts.<|end|><|start|>assistant<|channel|>final<|message|>Done<|return|>',
      }}
      gradeQuotes={[{
        message_index: 0,
        channel: 'text',
        start: 0,
        end: 39,
        text: 'We need to adapt to pass their asserts.',
      }]}
    />);

    const reasoningBlock = container.querySelector('[data-block-kind="reasoning"]');
    const mark = reasoningBlock?.querySelector('mark.grade-quote-mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('We need to adapt to pass their asserts.');
  });

  it('applies tool_call quote channels to structured tool-call text', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{
        role: 'assistant',
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{"command":"cat results.txt"}' } },
        ],
      }}
      gradeQuotes={[{ message_index: 0, channel: 'tool_call', start: 0, end: 15, text: 'cat results.txt' }]}
    />);

    const toolBlock = container.querySelector('[data-block-kind="tool"]');
    const mark = toolBlock?.querySelector('mark.grade-quote-mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('cat results.txt');
  });

  it('applies tool_result quote channels to tool-role content', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'tool', content: 'tool output line' }}
      gradeQuotes={[{ message_index: 0, channel: 'tool_result', start: 0, end: 11, text: 'tool output' }]}
    />);

    const contentBlock = container.querySelector('[data-block-kind="content"]');
    const mark = contentBlock?.querySelector('mark.grade-quote-mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('tool output');
  });

  it('collapses and expands on header click', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'user', content: 'Collapsible content' }} />);
    // Content should be visible initially
    expect(screen.getByText('Collapsible content')).toBeInTheDocument();

    // Click the header to collapse
    const header = screen.getByText('user').closest('[class*="cursor-pointer"]');
    if (header) fireEvent.click(header);

    // The grid-rows class should change to 0fr when collapsed. The text now
    // appears twice — hidden body + the header's one-line excerpt — so pick
    // the body occurrence (the one inside the grid wrapper).
    const contentWrapper = screen.getAllByText('Collapsible content')
      .map(el => el.closest('[class*="grid"]'))
      .find(el => el !== null);
    expect(contentWrapper?.className).toContain('grid-rows-[0fr]');
    // …and the collapsed header carries the excerpt.
    const excerpt = screen.getAllByText('Collapsible content').find(el => el.className.includes('truncate'));
    expect(excerpt).toBeDefined();
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

  it('does not render the placeholder Cut/Edit buttons', () => {
    render(<MessageCard {...defaultProps} />);
    expect(screen.queryByTitle('Remove this and all subsequent messages')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Edit message')).not.toBeInTheDocument();
  });

  it('hover-revealed buttons stay keyboard reachable via focus-visible', () => {
    render(<MessageCard {...defaultProps} isPresentationMode={true} />);
    expect(screen.getByTestId('preview-message-btn').className).toContain('focus-visible:opacity-100');
    expect(screen.getByTestId('capture-message-btn').className).toContain('focus-visible:opacity-100');
  });

  it('icon-only header buttons expose aria-labels and hide their icon glyphs', () => {
    render(<MessageCard {...defaultProps} />);
    const copyLink = screen.getByLabelText('Copy link to this message');
    expect(copyLink.querySelector('.material-symbols-outlined')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByLabelText('Share this message (no password needed)')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy message text (reasoning, content, tool calls)')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Local Ctrl+F search — current-match styling by global match index
// ---------------------------------------------------------------------------

describe('MessageCard current local match styling', () => {
  it('styles only the current local match with the green ring treatment', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'foo bar foo' }}
      localSearchTerm="foo"
      localOccurrenceStart={0}
      currentLocalMatchIndex={1}
    />);
    const marks = container.querySelectorAll('mark.local-search-mark');
    expect(marks.length).toBe(2);
    expect(marks[0].className).toContain('bg-green-200');
    expect(marks[0].className).not.toContain('ring-2');
    expect(marks[1].className).toContain('bg-green-400');
    expect(marks[1].className).toContain('ring-2');
    expect(marks[1].className).toContain('ring-green-500');
  });

  it('offsets the current-match check by localOccurrenceStart', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'needle here' }}
      localSearchTerm="needle"
      localOccurrenceStart={4}
      currentLocalMatchIndex={4}
    />);
    const mark = container.querySelector('mark.local-search-mark');
    expect(mark).not.toBeNull();
    expect(mark!.className).toContain('ring-2');
  });

  it('no match is current when the cursor points at another message', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'needle here' }}
      localSearchTerm="needle"
      localOccurrenceStart={4}
      currentLocalMatchIndex={2}
    />);
    const mark = container.querySelector('mark.local-search-mark');
    expect(mark!.className).not.toContain('ring-2');
    expect(mark!.className).toContain('bg-green-200');
  });

  it('advances local match indices across reasoning, content, and tool blocks in render order', () => {
    // Match order mirrors buildSearchCorpus: reasoning (0), content (1),
    // tool name (skipped, no match), tool args (2).
    const { container } = render(<MessageCard {...defaultProps}
      message={{
        role: 'assistant',
        content: '<think>needle in thought</think>needle in answer',
        tool_calls: [
          { type: 'function', function: { name: 'bash', arguments: '{"command":"grep needle file"}' } },
        ],
      }}
      localSearchTerm="needle"
      localOccurrenceStart={0}
      currentLocalMatchIndex={2}
    />);
    const toolMark = container.querySelector('[data-block-kind="tool"] mark.local-search-mark');
    expect(toolMark).not.toBeNull();
    expect(toolMark!.className).toContain('ring-2');
    const reasoningMark = container.querySelector('[data-block-kind="reasoning"] mark.local-search-mark');
    expect(reasoningMark).not.toBeNull();
    expect(reasoningMark!.className).not.toContain('ring-2');
    const contentMark = container.querySelector('[data-block-kind="content"] mark.local-search-mark');
    expect(contentMark!.className).not.toContain('ring-2');
  });
});

// ---------------------------------------------------------------------------
// Bulk expand/collapse signal
// ---------------------------------------------------------------------------

describe('MessageCard expand-all signal', () => {
  // Collapsed headers repeat the first content line as an excerpt, so the
  // text can match twice — always resolve to the body copy inside the grid.
  const gridOf = (text: string) =>
    screen.getAllByText(text)
      .map(el => el.closest('[class*="grid"]'))
      .find(el => el !== null) as HTMLElement;

  it('does not apply the signal value on initial mount', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'user', content: 'Signal content' }}
      expandAllSignal={{ value: false, version: 3 }}
    />);
    expect(gridOf('Signal content').className).toContain('grid-rows-[1fr]');
  });

  it('collapses on a version bump and allows per-card re-expansion afterwards', () => {
    const message = { role: 'user' as const, content: 'Signal content' };
    const { rerender } = render(<MessageCard {...defaultProps}
      message={message}
      expandAllSignal={{ value: true, version: 0 }}
    />);
    rerender(<MessageCard {...defaultProps}
      message={message}
      expandAllSignal={{ value: false, version: 1 }}
    />);
    expect(gridOf('Signal content').className).toContain('grid-rows-[0fr]');

    // Per-card toggle still works after the bulk collapse.
    const header = screen.getByText('user').closest('[class*="cursor-pointer"]');
    fireEvent.click(header!);
    expect(gridOf('Signal content').className).toContain('grid-rows-[1fr]');
  });

  it('re-sending the same version is a no-op', () => {
    const message = { role: 'user' as const, content: 'Signal content' };
    const { rerender } = render(<MessageCard {...defaultProps}
      message={message}
      expandAllSignal={{ value: false, version: 2 }}
    />);
    // Same version, new object identity — must not collapse.
    rerender(<MessageCard {...defaultProps}
      message={message}
      expandAllSignal={{ value: false, version: 2 }}
    />);
    expect(gridOf('Signal content').className).toContain('grid-rows-[1fr]');
  });
});

// ---------------------------------------------------------------------------
// Capture button feedback + P-shortcut parity
// ---------------------------------------------------------------------------

describe('MessageCard capture status feedback', () => {
  const iconOf = (btn: HTMLElement) =>
    btn.querySelector('.material-symbols-outlined')!.textContent;

  it('hides via opacity when idle and not hovered', () => {
    render(<MessageCard {...defaultProps} isPresentationMode={true} />);
    const btn = screen.getByTestId('capture-message-btn');
    expect(btn.className).toContain('opacity-0');
    expect(iconOf(btn)).toBe('photo_camera');
  });

  it('shows an hourglass and stays visible while busy', () => {
    render(<MessageCard {...defaultProps} isPresentationMode={true} captureStatus="busy" />);
    const btn = screen.getByTestId('capture-message-btn');
    expect(btn.className).toContain('opacity-100');
    expect(iconOf(btn)).toBe('hourglass_top');
  });

  it('shows a check when done', () => {
    render(<MessageCard {...defaultProps} isPresentationMode={true} captureStatus="done" />);
    const btn = screen.getByTestId('capture-message-btn');
    expect(btn.className).toContain('opacity-100');
    expect(iconOf(btn)).toBe('check');
  });

  it('shows a download icon and explanatory title when the clipboard fell back', () => {
    render(<MessageCard {...defaultProps} isPresentationMode={true} captureStatus="fallback" />);
    const btn = screen.getByTestId('capture-message-btn');
    expect(btn).toHaveAttribute('title', 'Clipboard unavailable — PNG downloaded');
    expect(iconOf(btn)).toBe('download');
  });

  it('shows an error icon on failure', () => {
    render(<MessageCard {...defaultProps} isPresentationMode={true} captureStatus="error" />);
    expect(iconOf(screen.getByTestId('capture-message-btn'))).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Long system/tool/file card clamping
// ---------------------------------------------------------------------------
//
// jsdom reports clientHeight/scrollHeight as 0, so the overflow measurement
// is mocked at the prototype level (configurable, removed after each test).

describe('MessageCard long-card clamping', () => {
  const longSystem = {
    role: 'system' as const,
    content: 'a very long system prompt line. '.repeat(80),
  };
  // Clamp height is role-dependent (system/file 160px, tool 240px) — match
  // any max-h so the tests survive tuning of the exact values.
  const clampedEl = (container: HTMLElement) =>
    container.querySelector('[class*="max-h-"]');

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 240,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  });

  it('clamps a long system card and reveals it via the footer bar', () => {
    const { container } = render(<MessageCard {...defaultProps} message={longSystem} />);
    expect(clampedEl(container)).not.toBeNull();

    // The footer bar states how much is hidden (mocked overflow: 760px ≈ 38
    // lines) and spans the full card width.
    const reveal = screen.getByTestId('clamp-reveal');
    expect(reveal.textContent).toMatch(/Show \d+ more lines/);
    expect(reveal.className).toContain('w-full');
    fireEvent.click(reveal);

    expect(clampedEl(container)).toBeNull();
    expect(screen.queryByTestId('clamp-reveal')).not.toBeInTheDocument();
    // A revealed long card offers the mirrored way back down.
    const collapse = screen.getByTestId('clamp-collapse');
    expect(collapse.textContent).toContain('Collapse');
    fireEvent.click(collapse);
    expect(clampedEl(container)).not.toBeNull();
    expect(screen.getByTestId('clamp-reveal')).toBeInTheDocument();
  });

  it('does not clamp user or assistant cards', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'assistant', content: 'a long answer. '.repeat(80) }}
    />);
    expect(clampedEl(container)).toBeNull();
    expect(screen.queryByTestId('clamp-reveal')).not.toBeInTheDocument();
  });

  it('renders no reveal chrome when the body fits within the clamp', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 240, // equals clientHeight — no overflow
    });
    render(<MessageCard {...defaultProps} message={{ role: 'system', content: 'short prompt' }} />);
    expect(screen.queryByTestId('clamp-reveal')).not.toBeInTheDocument();
  });

  it('the expand-all signal unclamps and collapse-all re-clamps', () => {
    const { container, rerender } = render(<MessageCard {...defaultProps}
      message={longSystem}
      expandAllSignal={{ value: true, version: 0 }}
    />);
    expect(clampedEl(container)).not.toBeNull();

    rerender(<MessageCard {...defaultProps}
      message={longSystem}
      expandAllSignal={{ value: true, version: 1 }}
    />);
    expect(clampedEl(container)).toBeNull();

    rerender(<MessageCard {...defaultProps}
      message={longSystem}
      expandAllSignal={{ value: false, version: 2 }}
    />);
    expect(clampedEl(container)).not.toBeNull();
  });

  it('never clamps the URL-highlight target card', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={longSystem}
      isHighlighted={true}
    />);
    expect(clampedEl(container)).toBeNull();
    expect(screen.queryByTestId('clamp-reveal')).not.toBeInTheDocument();
  });

  it('unclamps a card that contains the current local search match', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={{ role: 'system', content: 'needle buried in a long prompt' }}
      localSearchTerm="needle"
      localOccurrenceStart={0}
      currentLocalMatchIndex={0}
    />);
    expect(clampedEl(container)).toBeNull();
  });

  it('shows a tail preview of the last lines on a clamped tool card', () => {
    // 40 numbered lines: the head clamp hides the end, where errors and
    // results live — the tail block surfaces the last 6 lines.
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    render(<MessageCard {...defaultProps} message={{ role: 'tool', content: lines, name: 'bash' }} />);

    const tail = screen.getByTestId('clamp-tail');
    expect(tail).toHaveTextContent('line 40');
    expect(tail).toHaveTextContent('line 35');
    expect(tail).not.toHaveTextContent('line 34');
  });

  it('renders no tail preview on clamped system prose', () => {
    render(<MessageCard {...defaultProps} message={longSystem} />);
    expect(screen.queryByTestId('clamp-tail')).not.toBeInTheDocument();
  });

  it('never clamps in presentation mode', () => {
    const { container } = render(<MessageCard {...defaultProps}
      message={longSystem}
      isPresentationMode={true}
    />);
    expect(clampedEl(container)).toBeNull();
    expect(screen.queryByTestId('clamp-reveal')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Hover-revealed header action buttons
// ---------------------------------------------------------------------------

describe('MessageCard hover-reveal header buttons', () => {
  const labels = [
    'Copy link to this message',
    'Share this message (no password needed)',
    'Copy message text (reasoning, content, tool calls)',
  ];

  it('hides the header action buttons via opacity when idle and unhovered', () => {
    render(<MessageCard {...defaultProps} />);
    for (const label of labels) {
      const btn = screen.getByLabelText(label);
      expect(btn.className).toContain('opacity-0');
      expect(btn.className).toContain('focus-visible:opacity-100');
    }
  });

  it('reveals the header action buttons on hover', () => {
    const { container } = render(<MessageCard {...defaultProps} />);
    fireEvent.mouseOver(container.firstChild as Element);
    for (const label of labels) {
      const btn = screen.getByLabelText(label);
      expect(btn.className).toContain('opacity-100');
      expect(btn.className).not.toContain('opacity-0');
    }
  });
});

describe('MessageCard P shortcut', () => {
  it('captures the active (selected) card without hover', () => {
    const onCapture = vi.fn();
    render(<MessageCard {...defaultProps}
      index={3}
      isPresentationMode={true}
      isPresentationActive={true}
      onCaptureMessage={onCapture}
    />);
    fireEvent.keyDown(window, { key: 'p' });
    expect(onCapture).toHaveBeenCalledWith(3);
  });

  it('does not capture when neither hovered nor active', () => {
    const onCapture = vi.fn();
    render(<MessageCard {...defaultProps} isPresentationMode={true} onCaptureMessage={onCapture} />);
    fireEvent.keyDown(window, { key: 'p' });
    expect(onCapture).not.toHaveBeenCalled();
  });

  it('still captures the hovered card', () => {
    const onCapture = vi.fn();
    const { container } = render(<MessageCard {...defaultProps}
      index={1}
      isPresentationMode={true}
      onCaptureMessage={onCapture}
    />);
    fireEvent.mouseOver(container.firstChild as Element);
    fireEvent.keyDown(window, { key: 'p' });
    expect(onCapture).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// forCapture: the off-screen clone ChatView portals for image export
// ---------------------------------------------------------------------------
//
// Regression: the portal card used to inherit the role default (system cards
// start collapsed) and leak isExpanded/showFull across activeIndex changes, so
// an export could be a header-only strip.

describe('MessageCard forCapture', () => {
  const longSystem = {
    role: 'system' as const,
    content: 'a very long system prompt line. '.repeat(80),
  };

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 240,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  });

  it('mounts a system card open with no clamp footer', () => {
    render(<MessageCard {...defaultProps} message={longSystem} forCapture={true} />);
    expect(screen.getByTestId('message-body-grid').className).toContain('grid-rows-[1fr]');
    expect(screen.queryByTestId('clamp-reveal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clamp-collapse')).not.toBeInTheDocument();
    // No collapsed-header excerpt either — the body itself is showing.
    expect(screen.queryByTestId('collapsed-line-count')).not.toBeInTheDocument();
  });

  it('still starts a system card collapsed without forCapture', () => {
    render(<MessageCard {...defaultProps} message={longSystem} />);
    expect(screen.getByTestId('message-body-grid').className).toContain('grid-rows-[0fr]');
  });

  it('ignores the bulk collapse-all signal', () => {
    const { rerender } = render(
      <MessageCard {...defaultProps} message={longSystem} forCapture={true}
        expandAllSignal={{ value: false, version: 0 }} />,
    );
    rerender(
      <MessageCard {...defaultProps} message={longSystem} forCapture={true}
        expandAllSignal={{ value: false, version: 1 }} />,
    );
    expect(screen.getByTestId('message-body-grid').className).toContain('grid-rows-[1fr]');
  });

  it('marks the collapse wrapper so the capture stylesheet can force it open', () => {
    const { container } = render(<MessageCard {...defaultProps} forCapture={true} />);
    expect(screen.getByTestId('message-body-grid').className).toContain('message-body-grid');
    expect(container.querySelector('.message-body-clip')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scan-mode header: fixed gutter, line-count badge, meta run, TASK head
// ---------------------------------------------------------------------------

describe('MessageCard scan-mode header', () => {
  const multiline = { role: 'tool' as const, content: 'one\ntwo\nthree\nfour', name: 'bash' };

  it('starts a system card collapsed and every other role expanded', () => {
    const gridOf = (text: string) =>
      screen.getAllByText(text)
        .map(el => el.closest('[class*="grid-rows"]'))
        .find(el => el !== null) as HTMLElement;

    const { unmount } = render(<MessageCard {...defaultProps}
      message={{ role: 'system', content: 'boilerplate prompt' }}
    />);
    expect(gridOf('boilerplate prompt').className).toContain('grid-rows-[0fr]');
    unmount();

    render(<MessageCard {...defaultProps} message={{ role: 'tool', content: 'stdout here' }} />);
    expect(gridOf('stdout here').className).toContain('grid-rows-[1fr]');
  });

  it('re-expands a collapsed system card from its header', () => {
    render(<MessageCard {...defaultProps} message={{ role: 'system', content: 'boilerplate prompt' }} />);
    fireEvent.click(screen.getByText('system').closest('[class*="cursor-pointer"]')!);
    const grid = screen.getAllByText('boilerplate prompt')
      .map(el => el.closest('[class*="grid-rows"]'))
      .find(el => el !== null) as HTMLElement;
    expect(grid.className).toContain('grid-rows-[1fr]');
  });

  it('force-expands a collapsed system card that is the deep-link target', () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'system', content: 'boilerplate prompt' }}
      isHighlighted={true}
    />);
    const grid = screen.getAllByText('boilerplate prompt')
      .map(el => el.closest('[class*="grid-rows"]'))
      .find(el => el !== null) as HTMLElement;
    expect(grid.className).toContain('grid-rows-[1fr]');
  });

  it('shows a line-count badge only while collapsed', () => {
    render(<MessageCard {...defaultProps} message={multiline} />);
    expect(screen.queryByTestId('collapsed-line-count')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('bash').closest('[class*="cursor-pointer"]')!);
    expect(screen.getByTestId('collapsed-line-count')).toHaveTextContent('4 L');
  });

  it('keeps the role label in a fixed-width gutter so excerpts align', () => {
    render(<MessageCard {...defaultProps} message={multiline} />);
    const label = screen.getByText('bash').parentElement as HTMLElement;
    expect(label.className).toContain('w-28');
    expect(label.className).toContain('shrink-0');
  });

  it('shows the header meta run when unhovered and hides it on hover', () => {
    const { container } = render(<MessageCard {...defaultProps} index={6} message={multiline} />);
    const meta = screen.getByTestId('header-meta');
    expect(meta).toHaveTextContent('#7 · 4 ln');
    expect(meta.className).toContain('opacity-100');
    expect(meta.className).toContain('pointer-events-none');

    fireEvent.mouseOver(container.firstChild as Element);
    expect(screen.getByTestId('header-meta').className).toContain('opacity-0');
  });

  it('gives the first user message a TASK running head and a bigger body', () => {
    render(<MessageCard {...defaultProps} isTaskMessage={true} />);
    expect(screen.getByText('TASK')).toBeInTheDocument();
    expect(screen.queryByText('user')).not.toBeInTheDocument();
    const body = screen.getByText('Hello world');
    expect(body.className).toContain('text-[16px]');
  });

  it("prefixes a bound tool result's label with the turn glyph", () => {
    render(<MessageCard {...defaultProps}
      message={{ role: 'tool', content: 'stdout', name: 'bash' }}
      isChainedToolResult={true}
    />);
    expect(screen.getByText('↳ bash')).toBeInTheDocument();
  });
});
