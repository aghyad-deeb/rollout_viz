import { render, screen, fireEvent } from '@testing-library/react';
import { Minimap } from './Minimap';
import { makeMessage } from '../../test/fixtures';
import type { Message, Quote, SearchCondition } from '../../types';

// ---------------------------------------------------------------------------
// jsdom has no layout, so the scroll container and its message wrappers get
// hand-stubbed measurements (the SampleTable-test approach: defineProperty /
// getBoundingClientRect overrides on the specific elements under test).
// ---------------------------------------------------------------------------

const CHILD_HEIGHT = 180;
const CHILD_GAP = 16;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function buildContainer(
  n: number,
  { clientHeight = 500, scrollHeight = 2000 }: { clientHeight?: number; scrollHeight?: number } = {},
): HTMLDivElement {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: scrollHeight });
  container.getBoundingClientRect = () => rect(0, clientHeight);
  for (let i = 0; i < n; i++) {
    const child = document.createElement('div');
    const top = CHILD_GAP + i * (CHILD_HEIGHT + CHILD_GAP);
    child.getBoundingClientRect = () => rect(top, CHILD_HEIGHT);
    container.appendChild(child);
  }
  document.body.appendChild(container);
  return container;
}

function makeCondition(term: string): SearchCondition {
  return { id: 'c1', field: 'all', operator: 'contains', term };
}

function renderMinimap(
  messages: Message[],
  container: HTMLDivElement,
  overrides: Partial<React.ComponentProps<typeof Minimap>> = {},
) {
  return render(
    <Minimap
      messages={messages}
      containerRef={{ current: container }}
      isDarkMode={false}
      searchConditions={[]}
      localSearchTerm=""
      gradeQuotes={[]}
      highlightedMessageIndex={null}
      onMessageClick={vi.fn()}
      {...overrides}
    />,
  );
}

const blockHeight = (i: number): number =>
  parseFloat((screen.getByTestId(`minimap-block-${i}`) as HTMLElement).style.height);

describe('Minimap', () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it('renders one block per message, tagged with its role', () => {
    const messages = [
      makeMessage('system', 'You are helpful.'),
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there'),
      makeMessage('tool', 'exit 0'),
    ];
    container = buildContainer(messages.length);
    renderMinimap(messages, container);

    expect(screen.getByTestId('conversation-minimap')).toBeInTheDocument();
    expect(screen.getByTestId('minimap-block-0')).toHaveAttribute('data-role', 'system');
    expect(screen.getByTestId('minimap-block-1')).toHaveAttribute('data-role', 'user');
    expect(screen.getByTestId('minimap-block-2')).toHaveAttribute('data-role', 'assistant');
    expect(screen.getByTestId('minimap-block-3')).toHaveAttribute('data-role', 'tool');
    expect(screen.queryByTestId('minimap-block-4')).not.toBeInTheDocument();
  });

  it('gives longer messages proportionally taller blocks, with a clickable minimum', () => {
    const messages = [
      makeMessage('user', 'hi'),
      makeMessage('tool', 'x'.repeat(10000)),
      makeMessage('assistant', 'y'.repeat(400)),
    ];
    container = buildContainer(messages.length);
    renderMinimap(messages, container);

    expect(blockHeight(1)).toBeGreaterThan(blockHeight(2));
    expect(blockHeight(2)).toBeGreaterThan(blockHeight(0));
    // Log scale: the 5000x length gap must not translate into a 5000x block.
    expect(blockHeight(1) / blockHeight(0)).toBeLessThan(10);
    // The two-character message stays clickable.
    expect(blockHeight(0)).toBeGreaterThanOrEqual(7);
  });

  it('clicking a block reports that message index', () => {
    const messages = [makeMessage('user', 'a'), makeMessage('assistant', 'b'), makeMessage('tool', 'c')];
    container = buildContainer(messages.length);
    const onMessageClick = vi.fn();
    renderMinimap(messages, container, { onMessageClick });

    fireEvent.click(screen.getByTestId('minimap-block-2'));
    expect(onMessageClick).toHaveBeenCalledTimes(1);
    expect(onMessageClick).toHaveBeenCalledWith(2);
  });

  it('shows tick overlays for global search, local search, grade quotes, and the deep link', () => {
    const messages = [
      makeMessage('user', 'find the needle here'),
      makeMessage('assistant', 'nothing to see'),
      makeMessage('tool', 'haystack output'),
    ];
    container = buildContainer(messages.length);
    const quotes: Quote[] = [{ message_index: 1, start: 0, end: 7, text: 'nothing' }];
    renderMinimap(messages, container, {
      searchConditions: [makeCondition('needle')],
      localSearchTerm: 'haystack',
      gradeQuotes: quotes,
      highlightedMessageIndex: 1,
    });

    // Yellow global-search tick on message 0 only.
    expect(screen.getByTestId('minimap-tick-global-0')).toBeInTheDocument();
    expect(screen.queryByTestId('minimap-tick-global-1')).not.toBeInTheDocument();
    // Green local-search tick on message 2 only.
    expect(screen.getByTestId('minimap-tick-local-2')).toBeInTheDocument();
    expect(screen.queryByTestId('minimap-tick-local-0')).not.toBeInTheDocument();
    // Purple grade-quote tick and blue deep-link tick on message 1.
    expect(screen.getByTestId('minimap-tick-quote-1')).toBeInTheDocument();
    expect(screen.getByTestId('minimap-tick-deeplink-1')).toBeInTheDocument();
  });

  it('hides itself when the transcript fits without scrolling', () => {
    const messages = [makeMessage('user', 'a'), makeMessage('assistant', 'b')];
    container = buildContainer(messages.length, { clientHeight: 500, scrollHeight: 400 });
    renderMinimap(messages, container);
    expect(screen.queryByTestId('conversation-minimap')).not.toBeInTheDocument();
  });

  it('moves the viewport indicator on scroll (RAF-throttled)', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const messages = Array.from({ length: 8 }, (_, i) => makeMessage('user', `msg ${i}`));
    container = buildContainer(messages.length, { clientHeight: 500, scrollHeight: 1600 });
    renderMinimap(messages, container);

    const before = parseFloat((screen.getByTestId('minimap-viewport') as HTMLElement).style.top);
    container.scrollTop = 600;
    fireEvent.scroll(container);
    const after = parseFloat((screen.getByTestId('minimap-viewport') as HTMLElement).style.top);
    expect(after).toBeGreaterThan(before);
  });

  it('shows a tooltip with role, index, and a preview on hover', () => {
    const messages = [
      makeMessage('user', 'short'),
      makeMessage('assistant', 'The quick brown fox jumps over the lazy dog and keeps on running far away'),
    ];
    container = buildContainer(messages.length);
    renderMinimap(messages, container);

    expect(screen.queryByTestId('minimap-tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTestId('minimap-block-1'));
    const tooltip = screen.getByTestId('minimap-tooltip');
    expect(tooltip).toHaveTextContent('#2 · assistant');
    expect(tooltip).toHaveTextContent('The quick brown fox');
    // Preview is capped at ~60 chars.
    expect(tooltip.textContent!.length).toBeLessThan(90);

    fireEvent.mouseLeave(screen.getByTestId('conversation-minimap'));
    expect(screen.queryByTestId('minimap-tooltip')).not.toBeInTheDocument();
  });

  it('keeps blocks out of the tab order so keyboard navigation is unaffected', () => {
    const messages = [makeMessage('user', 'a'), makeMessage('assistant', 'b')];
    container = buildContainer(messages.length);
    renderMinimap(messages, container);
    expect(screen.getByTestId('minimap-block-0')).toHaveAttribute('tabindex', '-1');
  });

  it('is wrapped in React.memo (no re-render storm from ChatView state churn)', () => {
    expect(Minimap).toHaveProperty('$$typeof', Symbol.for('react.memo'));
  });

  it('re-renders 100x with identical props in under 150ms', () => {
    const messages = Array.from({ length: 30 }, (_, i) => makeMessage('user', `msg ${i}`));
    container = buildContainer(messages.length);
    const stable = {
      messages,
      containerRef: { current: container },
      isDarkMode: false,
      searchConditions: [] as SearchCondition[],
      localSearchTerm: '',
      gradeQuotes: [] as Quote[],
      highlightedMessageIndex: null,
      onMessageClick: vi.fn(),
    };
    const { rerender } = render(<Minimap {...stable} />);
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      rerender(<Minimap {...stable} />);
    }
    expect(performance.now() - start).toBeLessThan(150);
  });
});
