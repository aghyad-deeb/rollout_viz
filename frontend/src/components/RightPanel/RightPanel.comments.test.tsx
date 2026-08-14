import { useState, type ComponentProps } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RightPanel } from './index';
import { makeSample } from '../../test/fixtures';

// The transcript itself is irrelevant here — these tests are about how the
// comments drawer is wired into the panel (open state owned by the caller,
// focus handoff, attention signal, and the shrink-don't-cover layout).
vi.mock('./ChatView', () => ({
  ChatView: () => <div data-testid="chat-view">chat</div>,
}));

type RightPanelProps = ComponentProps<typeof RightPanel>;

function makeProps(overrides: Partial<RightPanelProps> = {}): RightPanelProps {
  return {
    sample: makeSample({ id: 0 }),
    filteredSamples: [makeSample({ id: 0 })],
    experimentName: 'test_exp',
    viewMode: 'chat',
    onViewModeChange: vi.fn(),
    onNavigate: vi.fn(),
    searchConditions: [],
    currentOccurrenceIndex: 0,
    isDarkMode: false,
    filePath: 'test.jsonl',
    generateLink: vi.fn(() => 'http://localhost:3000/?file=test.jsonl'),
    highlightedMessageIndex: null,
    highlightedText: null,
    onClearHighlight: vi.fn(),
    annotator: 'ada',
    onAnnotatorChange: vi.fn(),
    onAddComment: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** Renders RightPanel with the open flag held by the caller, as App does. */
function renderWithOpenState(overrides: Partial<RightPanelProps> = {}) {
  function Host() {
    const [isCommentsOpen, setIsCommentsOpen] = useState(false);
    return (
      <RightPanel
        {...makeProps(overrides)}
        isCommentsOpen={isCommentsOpen}
        onToggleComments={() => setIsCommentsOpen(v => !v)}
      />
    );
  }
  return render(<Host />);
}

const toggle = () => screen.getByRole('button', { name: /^Comments/ });
const drawer = () => screen.getByRole('dialog', { name: 'Comments' });
const composer = () => screen.getByLabelText('Comment') as HTMLTextAreaElement;

describe('RightPanel comments wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens and closes from the caller-owned toggle', () => {
    renderWithOpenState();
    expect(screen.queryByRole('dialog', { name: 'Comments' })).not.toBeInTheDocument();

    fireEvent.click(toggle());
    expect(drawer().className).not.toContain('hidden');

    fireEvent.click(toggle());
    // Still mounted (drafts survive), just hidden.
    expect(drawer().className).toContain('hidden');
  });

  it('lays the drawer out as a flex sibling of the transcript on sm+', () => {
    renderWithOpenState();
    fireEvent.click(toggle());
    const panel = drawer();
    // Static + fixed width at sm+ → the content column shrinks beside it,
    // instead of the drawer covering the chat it annotates.
    expect(panel.className).toContain('sm:static');
    expect(panel.className).toContain('sm:w-[24rem]');
    expect(panel.className).toContain('sm:shrink-0');

    // …and it is NOT inside the content column (which would make it an overlay).
    const chat = screen.getByTestId('chat-view');
    expect(chat.parentElement!.contains(panel)).toBe(false);
    const row = panel.parentElement!;
    expect(row.className).toContain('flex');
    expect(row.contains(chat)).toBe(true);
  });

  it('returns focus to the toolbar toggle when the drawer is closed with X', () => {
    renderWithOpenState();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByLabelText('Close comments'));
    expect(drawer().className).toContain('hidden');
    expect(document.activeElement).toBe(toggle());
  });

  it('returns focus to the toolbar toggle when Escape closes the drawer', () => {
    renderWithOpenState();
    fireEvent.click(toggle());
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(drawer().className).toContain('hidden');
    expect(document.activeElement).toBe(toggle());
  });

  it('flags an unposted draft on the toggle, including after the drawer closes', () => {
    renderWithOpenState();
    fireEvent.click(toggle());
    expect(screen.queryByTestId('comments-attention-dot')).not.toBeInTheDocument();

    fireEvent.change(composer(), { target: { value: 'half-written' } });
    expect(screen.getByTestId('comments-attention-dot')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close comments'));
    expect(screen.getByTestId('comments-attention-dot')).toBeInTheDocument();

    // Clearing the draft clears the flag, drawer open or not.
    fireEvent.click(toggle());
    fireEvent.change(composer(), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Close comments'));
    expect(screen.queryByTestId('comments-attention-dot')).not.toBeInTheDocument();
  });

  it('hides the toggle entirely when commenting is unavailable', () => {
    render(<RightPanel {...makeProps({ onAddComment: undefined })} />);
    expect(screen.queryByRole('button', { name: /^Comments/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Comments' })).not.toBeInTheDocument();
  });
});
