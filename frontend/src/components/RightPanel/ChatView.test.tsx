import { useState, type ComponentProps } from 'react';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { ChatView } from './ChatView';
import { PAPER_FONT_SCALE } from '../../utils/captureImage';
import type { Sample, SampleGrades } from '../../types';

// Controls for the MessageCard mock below. Integration-style tests
// (collapse-all, local-search mark navigation) flip `useRealMessageCard`
// to render the real component. vi.hoisted so the hoisted mock factory
// can read it.
const mockControls = vi.hoisted(() => ({ useRealMessageCard: false }));

// Capture-pipeline mocks — jsdom can't rasterize cards, so the capture
// feedback tests drive these instead of the real renderer.
const captureMocks = vi.hoisted(() => ({
  captureCardToPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  copyImageToClipboard: vi.fn(async () => true),
  downloadBlob: vi.fn(),
  encodeImage: vi.fn(async () => new Blob(['pdf'], { type: 'application/pdf' })),
}));

// Only the three rasterizing/clipboard entry points are stubbed — the pure
// helpers (font-scale resolution, presets) stay real so the figure-style
// plumbing test below asserts the actual derived scale.
vi.mock('../../utils/captureImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/captureImage')>();
  return {
    ...actual,
    captureCardToPng: captureMocks.captureCardToPng,
    copyImageToClipboard: captureMocks.copyImageToClipboard,
    downloadBlob: captureMocks.downloadBlob,
    encodeImage: captureMocks.encodeImage,
  };
});

vi.mock('../../utils/pngMetadata', () => ({
  readPngTextChunks: vi.fn(async () => ({})),
  stripPngTextChunks: vi.fn(async (blob: Blob) => blob),
}));

// Mock MessageCard to render a simple representation of each message.
// Exposes an `add-highlight-<index>` button so tests can simulate the
// selection-popup "Highlight" click without wiring the real selection API,
// plus capture / expand-signal probes for the ChatView-side plumbing tests.
vi.mock('./MessageCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageCard')>();

  interface MockProps {
    message: { role: string; content: string };
    index: number;
    onAddEphemeralHighlight?: (messageIndex: number, text: string) => void;
    isPresentationMode?: boolean;
    onPreviewSelect?: (messageIndex: number) => void;
    onCaptureMessage?: (messageIndex: number) => void;
    onPreviewMessage?: (messageIndex: number) => void;
    captureStatus?: string;
    expandAllSignal?: { value: boolean; version: number };
  }

  const MockMessageCard = ({
    message,
    index,
    onAddEphemeralHighlight,
    isPresentationMode,
    onPreviewSelect,
    onCaptureMessage,
    onPreviewMessage,
    captureStatus,
    expandAllSignal,
  }: MockProps) => (
    <div
      data-testid={`message-${index}`}
      onMouseDown={() => { if (isPresentationMode) onPreviewSelect?.(index); }}
    >
      <span data-testid={`role-${index}`}>{message.role}</span>
      <span data-testid={`content-${index}`}>{message.content}</span>
      <span data-testid={`capture-status-${index}`}>{captureStatus ?? 'none'}</span>
      <span data-testid={`expand-signal-${index}`}>
        {expandAllSignal ? `${expandAllSignal.value}:${expandAllSignal.version}` : 'no-signal'}
      </span>
      <button
        data-testid={`add-highlight-${index}`}
        onClick={() => onAddEphemeralHighlight?.(index, `hl-${index}`)}
      >
        add-highlight
      </button>
      <button
        data-testid={`capture-${index}`}
        onClick={() => onCaptureMessage?.(index)}
      >
        capture
      </button>
      <button
        data-testid={`preview-${index}`}
        onClick={() => onPreviewMessage?.(index)}
      >
        preview
      </button>
    </div>
  );

  return {
    MessageCard: (props: ComponentProps<typeof actual.MessageCard>) =>
      mockControls.useRealMessageCard
        ? <actual.MessageCard {...props} />
        : <MockMessageCard {...(props as unknown as MockProps)} />,
  };
});

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

// jsdom doesn't implement scrollIntoView. Record the receiver of each call
// so tests can assert exactly which element the view scrolled to.
const scrolledElements: Element[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledElements.push(this);
  } as typeof Element.prototype.scrollIntoView;
});
beforeEach(() => {
  scrolledElements.length = 0;
  mockControls.useRealMessageCard = false;
});

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

  it('applies presentation drafts only while presentation mode is active', () => {
    const presentationDrafts = {
      0: {
        role: 'assistant' as const,
        content: 'Edited for presentation',
        reasoning: '',
        toolCallsJson: '',
      },
    };
    const { rerender } = render(
      <ChatView
        {...defaultProps}
        isPresentationMode={true}
        presentationDrafts={presentationDrafts}
      />,
    );

    expect(screen.getByTestId('role-0')).toHaveTextContent('assistant');
    expect(screen.getByTestId('content-0')).toHaveTextContent('Edited for presentation');

    rerender(
      <ChatView
        {...defaultProps}
        isPresentationMode={false}
        presentationDrafts={presentationDrafts}
      />,
    );

    expect(screen.getByTestId('role-0')).toHaveTextContent('user');
    expect(screen.getByTestId('content-0')).toHaveTextContent('Hello, how are you?');
  });

  it('reports the active presentation card when a message is selected', () => {
    const onPresentationActiveIndexChange = vi.fn();
    render(
      <ChatView
        {...defaultProps}
        isPresentationMode={true}
        onPresentationActiveIndexChange={onPresentationActiveIndexChange}
      />,
    );

    fireEvent.mouseDown(screen.getByTestId('message-1'));

    expect(onPresentationActiveIndexChange).toHaveBeenCalledWith(1);
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
    // Step is dropped — the navigation bar already shows it.
    expect(screen.queryByText('Step:')).not.toBeInTheDocument();
    expect(screen.getByText('Reward:')).toBeInTheDocument();
    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(screen.getByText('Rollout:')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Source:')).toBeInTheDocument();
    const source = screen.getByText('test/source');
    expect(source).toHaveAttribute('title', 'test/source');
    expect(source.className).toContain('truncate');
    expect(screen.getByText('Timestamp:')).toBeInTheDocument();
    // The rendered timestamp is locale-formatted; the raw ISO string lives
    // in the title attribute.
    const tsEl = screen.getByTitle('2026-01-15T10:00:00');
    expect(tsEl).toBeInTheDocument();
    expect(tsEl).toHaveAttribute('title', '2026-01-15T10:00:00');
  });

  it('shows search chat button when search is not open', () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.getByLabelText('Search chat')).toBeInTheDocument();
  });

  it('floats the toolbar cluster outside the messages scroll container', () => {
    render(<ChatView {...defaultProps} />);
    // message testid div → keyed wrapper div → messages scroll container.
    const messagesContainer = screen.getByTestId('message-0').parentElement!.parentElement!;
    const collapseAll = screen.getByLabelText('Collapse all messages');
    // The cluster must be a SIBLING of the messages div (the Cmd+C handler
    // maps `:scope > div` children of the messages container)...
    expect(messagesContainer.contains(collapseAll)).toBe(false);
    // ...but overlaid within the same relative wrapper.
    expect(messagesContainer.parentElement!.contains(collapseAll)).toBe(true);
    expect(screen.getByLabelText('Expand all messages')).toBeInTheDocument();
    expect(screen.getByLabelText('Search chat')).toBeInTheDocument();
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
    const { rerender } = render(<ChatView key={defaultProps.sample.id} {...defaultProps} />);
    fireEvent.click(screen.getByTestId('add-highlight-0'));
    expect(screen.getByTitle(/Clear all highlights/)).toBeInTheDocument();

    // RightPanel keys ChatView by sample id, so sample-scoped presentation state
    // clears via remount when the selected sample changes.
    const nextSample = makeSample({ id: 999 });
    rerender(<ChatView key={nextSample.id} {...defaultProps} sample={nextSample} />);
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
    expect(positiveReward.className).toContain('text-teal-700');

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
    // listener consistently, so we click the "Search chat" icon button —
    // it triggers the same setIsSearchOpen(true) as the Ctrl+F binding.
    fireEvent.click(screen.getByLabelText('Search chat'));
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

// ---------------------------------------------------------------------------
// Local Ctrl+F search — navigation to the exact match mark
// ---------------------------------------------------------------------------
//
// These run against the REAL MessageCard so the `.local-search-mark`
// elements exist and the scroll targets / current-match styling can be
// asserted end to end.

describe('ChatView local search navigation', () => {
  beforeEach(() => { mockControls.useRealMessageCard = true; });
  afterEach(() => { mockControls.useRealMessageCard = false; });

  function openSearch() {
    fireEvent.click(screen.getByLabelText('Search chat'));
  }
  function typeSearch(term: string) {
    const input = screen.getByPlaceholderText('Search in this chat...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: term } });
  }
  const twoMatchSample = () => makeSample({
    messages: [
      { role: 'user', content: 'first needle here' },
      { role: 'assistant', content: 'second needle there' },
    ],
  });

  it('auto-scrolls to the first exact match mark when a term is typed', () => {
    const { container } = render(<ChatView {...defaultProps} sample={twoMatchSample()} />);
    openSearch();
    typeSearch('needle');
    const marks = container.querySelectorAll('mark.local-search-mark');
    expect(marks.length).toBe(2);
    // The scroll target is the mark itself, not the whole message card.
    expect(scrolledElements[scrolledElements.length - 1]).toBe(marks[0]);
    // The cursor stays at the first match.
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('auto-scrolls only once per term', () => {
    render(<ChatView {...defaultProps} sample={twoMatchSample()} />);
    openSearch();
    typeSearch('needle');
    const countAfterType = scrolledElements.length;
    // Re-render with the same term (e.g. unrelated state change) — no re-scroll.
    typeSearch('needle');
    expect(scrolledElements.length).toBe(countAfterType);
  });

  it('Enter scrolls to the next match mark and styles it as current', () => {
    const { container } = render(<ChatView {...defaultProps} sample={twoMatchSample()} />);
    openSearch();
    typeSearch('needle');
    const input = screen.getByPlaceholderText('Search in this chat...');
    fireEvent.keyDown(input, { key: 'Enter' });

    const marks = container.querySelectorAll('mark.local-search-mark');
    expect(scrolledElements[scrolledElements.length - 1]).toBe(marks[1]);
    expect(screen.getByText('2/2')).toBeInTheDocument();
    // Distinct current-match styling: green ring on the current, plain
    // green on the rest.
    expect(marks[1].className).toContain('ring-2');
    expect(marks[1].className).toContain('bg-green-400');
    expect(marks[0].className).not.toContain('ring-2');
    expect(marks[0].className).toContain('bg-green-200');
  });

  it('falls back to scrolling the message element when no mark is rendered', () => {
    // Mock cards render no marks — exercises the message-ref fallback.
    mockControls.useRealMessageCard = false;
    render(<ChatView {...defaultProps} />);
    openSearch();
    typeSearch('how are you');
    const scrolled = scrolledElements[scrolledElements.length - 1] as HTMLElement;
    expect(scrolled.contains(screen.getByTestId('message-0'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ctrl+F ergonomics
// ---------------------------------------------------------------------------

describe('ChatView Ctrl+F ergonomics', () => {
  it('opens the search bar when Ctrl+F is pressed while closed', () => {
    render(<ChatView {...defaultProps} />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(screen.getByPlaceholderText('Search in this chat...')).toBeInTheDocument();
  });

  it('refocuses and selects the input when Ctrl+F is pressed while already open', () => {
    render(<ChatView {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Search chat'));
    const input = screen.getByPlaceholderText('Search in this chat...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    input.blur();
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('hello'.length);
  });
});

// ---------------------------------------------------------------------------
// Collapse-all / expand-all message cards
// ---------------------------------------------------------------------------
//
// Runs against the real MessageCard so the grid-rows collapse state is the
// genuine card behavior, not a re-implementation in the mock.

describe('ChatView collapse/expand all messages', () => {
  beforeEach(() => { mockControls.useRealMessageCard = true; });
  afterEach(() => { mockControls.useRealMessageCard = false; });

  // Collapsed headers repeat the first content line as an excerpt, so the
  // text can match twice — resolve to the body copy inside the grid wrapper.
  const gridOf = (text: string) =>
    screen.getAllByText(text)
      .map(el => el.closest('[class*="grid-rows"]'))
      .find(el => el !== null) as HTMLElement;

  it('Collapse all collapses every card, then one card can be re-expanded individually', () => {
    render(<ChatView {...defaultProps} />);
    expect(gridOf('Hello, how are you?').className).toContain('grid-rows-[1fr]');

    fireEvent.click(screen.getByLabelText('Collapse all messages'));

    expect(gridOf('Hello, how are you?').className).toContain('grid-rows-[0fr]');
    expect(gridOf('I am doing well, thank you!').className).toContain('grid-rows-[0fr]');

    // Per-card toggle still works after the bulk action.
    const header = screen.getByText('TASK').closest('[class*="cursor-pointer"]');
    fireEvent.click(header!);
    expect(gridOf('Hello, how are you?').className).toContain('grid-rows-[1fr]');
    expect(gridOf('I am doing well, thank you!').className).toContain('grid-rows-[0fr]');
  });

  it('Expand all restores previously collapsed cards', () => {
    render(<ChatView {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Collapse all messages'));
    fireEvent.click(screen.getByLabelText('Expand all messages'));
    expect(gridOf('Hello, how are you?').className).toContain('grid-rows-[1fr]');
    expect(gridOf('I am doing well, thank you!').className).toContain('grid-rows-[1fr]');
  });
});

describe('ChatView expand-all signal plumbing', () => {
  it('passes expandAllSignal to list cards but not to the off-screen capture card', () => {
    render(<ChatView {...defaultProps} isPresentationMode={true} />);
    // Select a card → the capture portal renders a clone of it.
    fireEvent.mouseDown(screen.getByTestId('message-1'));
    const signals = screen.getAllByTestId('expand-signal-1').map((el) => el.textContent);
    expect(signals).toContain('true:0'); // list card gets the signal
    expect(signals).toContain('no-signal'); // capture clone does not
  });
});

// ---------------------------------------------------------------------------
// Off-screen capture card: always full-bodied
// ---------------------------------------------------------------------------
//
// Regression: the portal card was one un-keyed MessageCard inheriting the
// role's on-screen default. With system cards collapsed by default, exporting
// a system message produced a header-only strip.

describe('ChatView off-screen capture card', () => {
  const withSystem = makeSample({
    messages: [
      { role: 'system', content: 'you are a helpful assistant boilerplate' },
      { role: 'assistant', content: 'I am doing well, thank you!' },
    ],
  });

  beforeEach(() => { mockControls.useRealMessageCard = true; });
  afterEach(() => { mockControls.useRealMessageCard = false; });

  const gridsFor = (text: string) =>
    screen.getAllByText(text, { exact: false })
      .map((el) => el.closest('[data-testid="message-body-grid"]'))
      .filter((el): el is HTMLElement => el !== null);

  it('renders the active system card expanded even though the on-screen one is collapsed', () => {
    const { container } = render(
      <ChatView {...defaultProps} sample={withSystem} isPresentationMode={true}
        presentationActiveIndex={0} onPresentationActiveIndexChange={vi.fn()} />,
    );
    // On-screen (inside `container`) the system card keeps its collapsed default…
    const onScreen = within(container).getAllByText('you are a helpful assistant boilerplate')
      .map((el) => el.closest('[data-testid="message-body-grid"]'))
      .filter((el): el is HTMLElement => el !== null);
    expect(onScreen.length).toBeGreaterThan(0);
    expect(onScreen.every((g) => g.className.includes('grid-rows-[0fr]'))).toBe(true);
    // …while the portalled capture clone (outside it) is expanded.
    const all = gridsFor('you are a helpful assistant boilerplate');
    expect(all.some((g) => g.className.includes('grid-rows-[1fr]'))).toBe(true);
  });

  it('remounts the capture card when the active message changes', () => {
    const { rerender } = render(
      <ChatView {...defaultProps} sample={withSystem} isPresentationMode={true}
        presentationActiveIndex={1} onPresentationActiveIndexChange={vi.fn()} />,
    );
    rerender(
      <ChatView {...defaultProps} sample={withSystem} isPresentationMode={true}
        presentationActiveIndex={0} onPresentationActiveIndexChange={vi.fn()} />,
    );
    // The clone now shows the system message, fully expanded — no state
    // carried over from the assistant card it replaced.
    const all = gridsFor('you are a helpful assistant boilerplate');
    expect(all.some((g) => g.className.includes('grid-rows-[1fr]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capture feedback (busy → done / fallback, auto-clearing)
// ---------------------------------------------------------------------------

describe('ChatView capture feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Drain the async capture pipeline (all microtask-based with the mocks).
  const flushCapture = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  };

  it('reports busy while rendering, done on success, and clears after ~2s', async () => {
    let resolvePng!: (blob: Blob) => void;
    captureMocks.captureCardToPng.mockImplementationOnce(
      () => new Promise<Blob>((resolve) => { resolvePng = resolve; }),
    );
    const { container } = render(<ChatView {...defaultProps} isPresentationMode={true} />);
    const q = within(container); // exclude the off-screen capture portal

    await act(async () => {
      fireEvent.click(q.getByTestId('capture-1'));
    });
    expect(q.getByTestId('capture-status-1')).toHaveTextContent('busy');

    // A second click while busy is ignored.
    fireEvent.click(q.getByTestId('capture-1'));
    expect(captureMocks.captureCardToPng).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePng(new Blob(['png'], { type: 'image/png' }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(q.getByTestId('capture-status-1')).toHaveTextContent('done');

    act(() => { vi.advanceTimersByTime(2100); });
    expect(q.getByTestId('capture-status-1')).toHaveTextContent('none');
  });

  // Figure style is inert plumbing until it reaches captureCardToPng: the
  // whole feature is scoped to the capture clone, so the ONLY thing ChatView
  // owes it is forwarding the style + the style's font scale.
  it('forwards the paper figure style and its derived 9pt font scale', async () => {
    const { container } = render(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="paper" exportWidth="col" imageTheme="dark" />,
    );
    await act(async () => { fireEvent.click(within(container).getByTestId('capture-0')); });
    await flushCapture();

    expect(captureMocks.captureCardToPng).toHaveBeenCalledTimes(1);
    expect(captureMocks.captureCardToPng.mock.calls[0][1]).toMatchObject({
      captureStyle: 'paper',
      exportWidth: 'col',
      fontScale: PAPER_FONT_SCALE,
    });
  });

  it('defaults to the screen style and the font preset when no style is given', async () => {
    const { container } = render(<ChatView {...defaultProps} isPresentationMode={true} fontSize="md" />);
    await act(async () => { fireEvent.click(within(container).getByTestId('capture-0')); });
    await flushCapture();

    const opts = captureMocks.captureCardToPng.mock.calls[0][1] as { captureStyle: string; fontScale: number };
    expect(opts.captureStyle).toBe('screen');
    expect(opts.fontScale).toBe(1.35);
  });

  it('reports fallback when the clipboard write fell back to a download', async () => {
    captureMocks.copyImageToClipboard.mockResolvedValueOnce(false);
    const { container } = render(<ChatView {...defaultProps} isPresentationMode={true} />);
    const q = within(container);

    await act(async () => {
      fireEvent.click(q.getByTestId('capture-0'));
    });
    await flushCapture();
    expect(q.getByTestId('capture-status-0')).toHaveTextContent('fallback');
  });
});

describe('ChatView live preview pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // jsdom has no object-URL support; the preview effect needs both.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: the preview effect must not re-arm itself when the parent
  // recreates its callbacks on every render (as inline arrow props do).
  // It once did — each completed capture updated parent state, the fresh
  // callback identity re-triggered the effect, and the app re-captured in an
  // endless loop with "Updating preview…" pinned on.
  it('captures once and settles pending=false even with unstable parent callbacks', async () => {
    const pendingLog: boolean[] = [];
    let previews = 0;

    function UnstableParent() {
      const [, setTick] = useState(0);
      return (
        <ChatView
          {...defaultProps}
          isPresentationMode={true}
          presentationActiveIndex={0}
          onPresentationActiveIndexChange={() => {}}
          onPresentationPreview={(url) => { if (url) previews += 1; setTick(t => t + 1); }}
          onPreviewPending={(p) => { pendingLog.push(p); setTick(t => t + 1); }}
        />
      );
    }

    render(<UnstableParent />);

    // The debounce arms → preview is marked stale.
    expect(pendingLog[pendingLog.length - 1]).toBe(true);

    // Let the debounce fire and the (mocked, microtask-based) capture finish.
    await act(async () => {
      vi.advanceTimersByTime(400);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(previews).toBe(1);
    expect(pendingLog[pendingLog.length - 1]).toBe(false);

    // The parent re-renders caused by those callbacks must not schedule
    // another capture.
    await act(async () => {
      vi.advanceTimersByTime(2000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(captureMocks.captureCardToPng).toHaveBeenCalledTimes(1);
    expect(previews).toBe(1);
    expect(pendingLog[pendingLog.length - 1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Presentation Mode exit (Escape + toolbar button)
// ---------------------------------------------------------------------------

describe('ChatView presentation exit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Escape exits presentation mode', () => {
    const onExit = vi.fn();
    render(<ChatView {...defaultProps} isPresentationMode={true} onExitPresentationMode={onExit} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Escape does nothing outside presentation mode', () => {
    const onExit = vi.fn();
    render(<ChatView {...defaultProps} isPresentationMode={false} onExitPresentationMode={onExit} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).not.toHaveBeenCalled();
  });

  it('the Exit (Esc) toolbar button calls onExitPresentationMode', () => {
    const onExit = vi.fn();
    render(<ChatView {...defaultProps} isPresentationMode={true} onExitPresentationMode={onExit} />);
    fireEvent.click(screen.getByText('Exit (Esc)'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Escape is ignored while an elision-pill menu is open', () => {
    const onExit = vi.fn();
    render(<ChatView {...defaultProps} isPresentationMode={true} onExitPresentationMode={onExit} />);
    const menu = document.createElement('div');
    menu.setAttribute('data-testid', 'elision-pill-menu');
    document.body.appendChild(menu);
    try {
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      menu.remove();
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the capture-preview modal without exiting presentation mode', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
    const onExit = vi.fn();
    const { container } = render(
      <ChatView {...defaultProps} isPresentationMode={true} onExitPresentationMode={onExit} />,
    );
    await act(async () => {
      fireEvent.click(within(container).getByTestId('preview-0'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(screen.getByTestId('capture-preview-backdrop')).toBeInTheDocument();

    // First Escape: the modal's own listener closes it; the exit guard sees
    // the open preview and stays quiet.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('capture-preview-backdrop')).not.toBeInTheDocument();

    // Second Escape (nothing open any more) exits.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Presentation toolbar hints (kbd chips + shortcuts popover)
// ---------------------------------------------------------------------------

describe('ChatView presentation toolbar hints', () => {
  it('renders the shortcut hints as kbd chips', () => {
    render(<ChatView {...defaultProps} isPresentationMode={true} />);
    expect(screen.getByText('Select text →')).toBeInTheDocument();
    for (const key of ['C', 'O', 'H', 'B', 'I', 'P']) {
      const kbd = screen.getByText(key);
      expect(kbd.tagName).toBe('KBD');
    }
  });

  it('opens the shortcuts popover from the ? button and closes it on Escape without exiting', () => {
    const onExit = vi.fn();
    render(<ChatView {...defaultProps} isPresentationMode={true} onExitPresentationMode={onExit} />);
    fireEvent.click(screen.getByLabelText('Presentation shortcuts help'));
    const popover = screen.getByTestId('presentation-help-popover');
    expect(popover.textContent).toMatch(/Shift\+C/);
    expect(popover.textContent).toMatch(/Drop an exported PNG/i);
    expect(popover.className).toContain('presentation-chrome');

    // Escape closes the popover but does NOT exit presentation mode.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('presentation-help-popover')).not.toBeInTheDocument();
    expect(onExit).not.toHaveBeenCalled();

    // A second Escape (popover gone) exits.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('closes the shortcuts popover on an outside click', () => {
    render(<ChatView {...defaultProps} isPresentationMode={true} />);
    fireEvent.click(screen.getByLabelText('Presentation shortcuts help'));
    expect(screen.getByTestId('presentation-help-popover')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('presentation-help-popover')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Capture filenames (rollout/step/message-derived)
// ---------------------------------------------------------------------------

describe('ChatView capture filenames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a rollout/step/message fallback filename to the clipboard copy', async () => {
    const { container } = render(<ChatView {...defaultProps} isPresentationMode={true} />);
    await act(async () => {
      fireEvent.click(within(container).getByTestId('capture-0'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(captureMocks.copyImageToClipboard).toHaveBeenCalledWith(
      expect.any(Blob),
      'test_exp · rollout 1 · step 100',
      'rollout-1-step100-msg1.png',
    );
  });

  it('downloads a previewed capture under the same descriptive filename', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
    const { container } = render(<ChatView {...defaultProps} isPresentationMode={true} />);
    await act(async () => {
      fireEvent.click(within(container).getByTestId('preview-1'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    fireEvent.click(screen.getByText('Download'));
    expect(captureMocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'rollout-1-step100-msg2.png');
    expect(captureMocks.encodeImage).not.toHaveBeenCalled();   // screen = PNG
  });

  it('downloads a PAPER preview as a PDF page at the nominal column width', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
    const { container } = render(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="paper" exportWidth="col" />,
    );
    await act(async () => {
      fireEvent.click(within(container).getByTestId('preview-1'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // The primary action names the format it produces; PNG stays one click away.
    await act(async () => {
      fireEvent.click(screen.getByText('Download PDF'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(captureMocks.encodeImage).toHaveBeenCalledWith(expect.any(Blob), 'pdf', 234);
    expect(captureMocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'rollout-1-step100-msg2.pdf');
  });

  it('keeps PNG available as the explicit secondary in the paper style', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
    const { container } = render(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="paper" exportWidth="full" />,
    );
    await act(async () => {
      fireEvent.click(within(container).getByTestId('preview-1'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'PNG' }));
    expect(captureMocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'rollout-1-step100-msg2.png');
    expect(captureMocks.encodeImage).not.toHaveBeenCalled();
  });

  it('leaves the clipboard on PNG in the paper style', async () => {
    const { container } = render(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="paper" exportWidth="col" />,
    );
    await act(async () => {
      fireEvent.click(within(container).getByTestId('capture-0'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(captureMocks.copyImageToClipboard).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.any(String),
      'rollout-1-step100-msg1.png',
    );
    expect(captureMocks.encodeImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Preview modal honesty: the modal describes the raster it HAS, not the live
// settings row behind it (the settings stay interactive while it is open).
// ---------------------------------------------------------------------------

describe('ChatView capture preview modal — settings snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  const openPreview = async (container: HTMLElement) => {
    await act(async () => {
      fireEvent.click(within(container).getByTestId('preview-1'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  };

  it('keeps a SCREEN preview on the screen download when the style flips to paper', async () => {
    const { container, rerender } = render(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="screen" exportWidth="paper1" />,
    );
    await openPreview(container);
    // The user flips the settings row while the modal is up. That governs the
    // NEXT capture; this raster is still screen pixels.
    rerender(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="paper" exportWidth="col" />,
    );

    expect(screen.queryByText('Download PDF')).toBeNull();
    expect(screen.queryByRole('button', { name: 'PNG' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Download'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    // Screen pixels must not be wrapped in a 234pt "column" page.
    expect(captureMocks.encodeImage).not.toHaveBeenCalled();
    expect(captureMocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'rollout-1-step100-msg2.png');
  });

  it('keeps a PAPER preview on its own page geometry when the settings move under it', async () => {
    const { container, rerender } = render(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="paper" exportWidth="col" />,
    );
    await openPreview(container);
    // Width changes to full-width (486pt) AND style flips back to screen.
    rerender(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="screen" exportWidth="slide" />,
    );

    // Still the paper modal, still the 234pt column the raster was made for.
    await act(async () => {
      fireEvent.click(screen.getByText('Download PDF'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(captureMocks.encodeImage).toHaveBeenCalledWith(expect.any(Blob), 'pdf', 234);
  });

  it('re-snapshots on the NEXT capture — a new preview follows the new settings', async () => {
    const { container, rerender } = render(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="screen" exportWidth="paper1" />,
    );
    await openPreview(container);
    rerender(
      <ChatView {...defaultProps} isPresentationMode={true} captureStyle="paper" exportWidth="full" />,
    );
    await openPreview(container);   // fresh capture under the new settings

    await act(async () => {
      fireEvent.click(screen.getByText('Download PDF'));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(captureMocks.encodeImage).toHaveBeenCalledWith(expect.any(Blob), 'pdf', 486);
  });
});

describe('ChatView conversation minimap', () => {
  // jsdom has no layout: fake an overflowing (or fitting) transcript by
  // stubbing the scroll metrics on the prototype, the same way the
  // MessageCard overflow tests do.
  const stubScrollMetrics = (scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
  };

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a role-tagged block per message when the transcript overflows', () => {
    stubScrollMetrics(2000, 500);
    render(<ChatView {...defaultProps} />);
    expect(screen.getByTestId('conversation-minimap')).toBeInTheDocument();
    expect(screen.getByTestId('minimap-block-0')).toHaveAttribute('data-role', 'user');
    expect(screen.getByTestId('minimap-block-1')).toHaveAttribute('data-role', 'assistant');
  });

  it('clicking a minimap block scrolls that message into view', () => {
    stubScrollMetrics(2000, 500);
    render(<ChatView {...defaultProps} />);
    fireEvent.click(screen.getByTestId('minimap-block-1'));
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0].contains(screen.getByTestId('message-1'))).toBe(true);
  });

  it('is hidden in Presentation Mode', () => {
    stubScrollMetrics(2000, 500);
    render(<ChatView {...defaultProps} isPresentationMode={true} />);
    expect(screen.queryByTestId('conversation-minimap')).not.toBeInTheDocument();
  });

  it('is hidden when the whole transcript fits without scrolling', () => {
    stubScrollMetrics(400, 500);
    render(<ChatView {...defaultProps} />);
    expect(screen.queryByTestId('conversation-minimap')).not.toBeInTheDocument();
  });
});

describe('ChatView role-aware message rhythm', () => {
  // The wrapper margins encode turn structure: a tool result binds to the
  // assistant call above it (4px + a 24px indent, and MessageCard prefixes
  // its label with '↳'), but consecutive tool results keep the full gap —
  // two hugging siblings would read as one card.
  it('binds a tool result to its assistant call but not to a preceding tool result', () => {
    const sample = makeSample({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'calling' },
        { role: 'tool', content: 'result one', name: 'bash' },
        { role: 'tool', content: 'result two', name: 'bash' },
        { role: 'assistant', content: 'done' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);

    const wrapperOf = (i: number) =>
      screen.getByTestId(`message-${i}`).parentElement as HTMLElement;
    expect(wrapperOf(0).className).toBe('');           // first message: no margin
    expect(wrapperOf(2).className).toContain('mt-1');   // tool after assistant binds
    expect(wrapperOf(2).className).toContain('ml-6');   // …and indents under it
    expect(wrapperOf(3).className).toContain('mt-4');   // tool after tool keeps the gap
    expect(wrapperOf(3).className).not.toContain('ml-6');
    expect(wrapperOf(4).className).toContain('mt-7');   // assistant opens a paragraph
  });

  it("prefixes a bound tool result's header label with the turn glyph", () => {
    mockControls.useRealMessageCard = true;
    const sample = makeSample({
      messages: [
        { role: 'assistant', content: 'calling' },
        { role: 'tool', content: 'result one', name: 'bash' },
        { role: 'tool', content: 'result two', name: 'bash' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    expect(screen.getByText('↳ bash')).toBeInTheDocument(); // bound to the call
    expect(screen.getByText('bash')).toBeInTheDocument();   // free-standing result
  });
});

// ---------------------------------------------------------------------------
// First-screen economy: task primacy + collapsed system prompts
// ---------------------------------------------------------------------------

describe('ChatView first-screen economy', () => {
  beforeEach(() => { mockControls.useRealMessageCard = true; });
  afterEach(() => { mockControls.useRealMessageCard = false; });

  it("gives ONLY the first user message the TASK running head", () => {
    const sample = makeSample({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'the actual task' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'a follow-up' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    expect(screen.getAllByText('TASK')).toHaveLength(1);
    expect(screen.getAllByText('user')).toHaveLength(1); // the follow-up
  });

  it('starts system cards collapsed and every other role expanded', () => {
    const sample = makeSample({
      messages: [
        { role: 'system', content: 'a long system prompt' },
        { role: 'user', content: 'the actual task' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    const gridOf = (text: string) =>
      screen.getAllByText(text)
        .map(el => el.closest('[class*="grid-rows"]'))
        .find(el => el !== null) as HTMLElement;
    expect(gridOf('a long system prompt').className).toContain('grid-rows-[0fr]');
    expect(gridOf('the actual task').className).toContain('grid-rows-[1fr]');

    // Still individually expandable…
    fireEvent.click(screen.getByText('system').closest('[class*="cursor-pointer"]')!);
    expect(gridOf('a long system prompt').className).toContain('grid-rows-[1fr]');
  });

  it('expand-all opens the collapsed system card', () => {
    const sample = makeSample({
      messages: [
        { role: 'system', content: 'a long system prompt' },
        { role: 'user', content: 'the actual task' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    fireEvent.click(screen.getByLabelText('Expand all messages'));
    const grid = screen.getAllByText('a long system prompt')
      .map(el => el.closest('[class*="grid-rows"]'))
      .find(el => el !== null) as HTMLElement;
    expect(grid.className).toContain('grid-rows-[1fr]');
  });
});

describe('ChatView tool-echo stripping', () => {
  it('hides a command echoed at the head of its tool result, keeping raw_content', () => {
    const sample = makeSample({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ type: 'function', function: { name: 'bash', arguments: { command: 'ls -la' } } }],
        },
        { role: 'tool', content: 'ls -la\ntotal 4\nfile.txt', name: 'bash' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    const toolContent = screen.getByTestId('content-2');
    expect(toolContent).toHaveTextContent('total 4');
    expect(toolContent.textContent).not.toContain('ls -la');
  });

  it('leaves non-echoing tool results untouched', () => {
    const sample = makeSample({
      messages: [
        {
          role: 'assistant', content: '',
          tool_calls: [{ type: 'function', function: { name: 'bash', arguments: { command: 'ls -la' } } }],
        },
        { role: 'tool', content: 'total 4\nfile.txt', name: 'bash' },
      ],
    });
    render(<ChatView {...defaultProps} sample={sample} />);
    expect(screen.getByTestId('content-1')).toHaveTextContent('total 4');
  });
});

// ---------------------------------------------------------------------------
// Reading-position anchor across Presentation Mode toggles
// ---------------------------------------------------------------------------
//
// The mode flip reflows the whole transcript (the scroller swaps scrollbar
// chrome, a toolbar row appears), so a raw scrollTop lands on different
// content. ChatView tracks the topmost visible card on scroll and re-pins it
// at the same offset when isPresentationMode changes. jsdom has no layout:
// rects are stubbed per element and the RAF throttle is made synchronous.

describe('ChatView presentation-mode reading anchor', () => {
  const rect = (top: number, bottom: number): DOMRect =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect);

  it('re-pins the topmost visible card when the mode flips', () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
    const sample = makeSample({ messages });
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb) => { cb(0); return 1; });
    try {
      const { container, rerender } = render(
        <ChatView {...defaultProps} sample={sample} isPresentationMode={false} />
      );
      const scroller = container.querySelector('.transcript-surface') as HTMLElement;
      const wrappers = Array.from(scroller.children) as HTMLElement[];
      expect(wrappers).toHaveLength(6);

      let scrollTop = 250;
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => { scrollTop = v; },
      });
      scroller.getBoundingClientRect = () => rect(0, 500);
      // Simulated layout: every card `h` px tall, stacked from the top.
      const layout = (h: number) => {
        wrappers.forEach((w, i) => {
          w.getBoundingClientRect = () => rect(i * h - scrollTop, (i + 1) * h - scrollTop);
        });
      };
      layout(100);
      // At scrollTop 250 the topmost visible card is #2 (top at -50).
      fireEvent.scroll(scroller);

      // The flip re-lays every card out taller (150px), the way the
      // scrollbar/toolbar reflow does; card #2 must stay pinned at -50.
      layout(150);
      rerender(<ChatView {...defaultProps} sample={sample} isPresentationMode={true} />);

      // #2's new natural top is 300 at the old scrollTop 250 → the anchor
      // effect adds 100 so its on-screen offset is -50 again.
      expect(scrollTop).toBe(350);
    } finally {
      rafSpy.mockRestore();
    }
  });
});
