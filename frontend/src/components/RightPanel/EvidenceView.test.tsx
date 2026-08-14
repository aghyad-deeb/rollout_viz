import { render, screen, fireEvent, within } from '@testing-library/react';
import { EvidenceView } from './EvidenceView';
import type { GradeEntry, Sample } from '../../types';
import { makeSample, makeMessage } from '../../test/fixtures';

function makeEntry(overrides: Partial<GradeEntry> = {}): GradeEntry {
  return {
    grade: true,
    grade_type: 'bool',
    quotes: [],
    explanation: '',
    model: 'gpt-4o',
    prompt_version: 'v1',
    timestamp: '2026-01-15T10:00:00',
    ...overrides,
  };
}

const FOUND_TEXT = 'hacked the reward';
const S1_CONTENT = `the model ${FOUND_TEXT} function to win`;

// Judge entries kept as consts so onAudit assertions can check the exact
// entry object is forwarded.
const s1Entry = makeEntry({
  grade: true,
  quotes: [
    {
      message_index: 1,
      start: S1_CONTENT.indexOf(FOUND_TEXT),
      end: S1_CONTENT.indexOf(FOUND_TEXT) + FOUND_TEXT.length,
      text: FOUND_TEXT,
    },
  ],
  explanation: 'Clear reward hack.',
});
const s2Entry = makeEntry({
  grade: false,
  quotes: [{ message_index: 1, start: 0, end: 16, text: 'fabricated quote' }],
  explanation: 'Suspicious behavior.',
});
const s3Entry = makeEntry({ grade: true, quotes: [] });
const floatEntry = makeEntry({ grade: 0.42, grade_type: 'float', quotes: [] });

// Feed order for metric 'hack': s3 (noEvidence) -> s2 (quoteNotFound) -> s1 (clean).
function makeCorpus(): Sample[] {
  return [
    makeSample({
      id: 1,
      messages: [makeMessage('user', 'go'), makeMessage('assistant', S1_CONTENT)],
      attributes: { rollout_n: 11, source_file: '/data/exp1/file_a.jsonl', reward: 0.8 },
      grades: { hack: [s1Entry], aaa_score: [floatEntry] },
    }),
    makeSample({
      id: 2,
      messages: [makeMessage('user', 'go'), makeMessage('assistant', 'nothing suspicious here')],
      attributes: { rollout_n: 22, source_file: '/data/exp1/file_a.jsonl', reward: -0.3 },
      grades: { hack: [s2Entry] },
    }),
    makeSample({
      id: 3,
      messages: [makeMessage('user', 'go'), makeMessage('assistant', 'plain answer')],
      attributes: { rollout_n: 33, source_file: '/data/exp1/file_a.jsonl', reward: 0.1 },
      grades: { hack: [s3Entry] },
    }),
  ];
}

const defaultProps = {
  isDarkMode: false,
  annotator: 'alice',
  onOpenQuote: vi.fn(),
  onAudit: vi.fn(),
};

function renderView(overrides: Partial<Parameters<typeof EvidenceView>[0]> = {}) {
  return render(<EvidenceView samples={makeCorpus()} {...defaultProps} {...overrides} />);
}

function valueFilterGroup() {
  return screen.getByRole('group', { name: 'Filter by grade value' });
}
function flagFilterGroup() {
  return screen.getByRole('group', { name: 'Filter by flags' });
}
function cards() {
  return screen.getAllByTestId('evidence-card');
}

describe('EvidenceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('metric select', () => {
    it('renders one option per graded metric with counts, defaulting to the first metric with quotes', () => {
      renderView();
      const select = screen.getByLabelText('Evidence metric') as HTMLSelectElement;
      expect(
        screen.getByRole('option', { name: 'hack — 3 graded · 2 quotes' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('option', { name: 'aaa_score — 1 graded · 0 quotes' }),
      ).toBeInTheDocument();
      // 'aaa_score' sorts first but has no quotes -> default is 'hack'.
      expect(select.value).toBe('hack');
    });

    it('switches the feed when a different metric is chosen', () => {
      renderView();
      fireEvent.change(screen.getByLabelText('Evidence metric'), {
        target: { value: 'aaa_score' },
      });
      expect(cards()).toHaveLength(1);
      expect(screen.getByText('0.42')).toBeInTheDocument();
      expect(screen.getByText('The judge saved no supporting quotes.')).toBeInTheDocument();
      // Float metric -> no bool value filter.
      expect(screen.queryByRole('group', { name: 'Filter by grade value' })).not.toBeInTheDocument();
    });
  });

  describe('cards', () => {
    it('renders flagged cards first, contexts with a purple mark, flag badges, and the summary', () => {
      renderView();
      expect(cards()).toHaveLength(3);
      expect(screen.getByText('3 evidence items across 3 rollouts')).toBeInTheDocument();

      // Clean card: context with the located quote marked, surrounded by the
      // before/after slices of the original message.
      const mark = screen.getByText(FOUND_TEXT);
      expect(mark.tagName).toBe('MARK');
      expect(mark.parentElement?.textContent).toBe(S1_CONTENT);

      // Flag badges + bodies.
      expect(screen.getByText('no evidence saved')).toBeInTheDocument();
      expect(screen.getByText('quote not found in transcript')).toBeInTheDocument();
      expect(screen.getByText('judge quoted:')).toBeInTheDocument();
      expect(screen.getByText('fabricated quote')).toBeInTheDocument();
      expect(screen.getByText('The judge saved no supporting quotes.')).toBeInTheDocument();

      // Flagged cards precede the clean one: noEvidence, then quoteNotFound.
      const [first, second, third] = cards();
      expect(within(first).getByText('Rollout 33')).toBeInTheDocument();
      expect(within(second).getByText('Rollout 22')).toBeInTheDocument();
      expect(within(third).getByText('Rollout 11')).toBeInTheDocument();
    });

    it('shows a gray badge for metadata-only samples', () => {
      const samples = [
        makeSample({
          id: 9,
          messages: [],
          attributes: { rollout_n: 9, source_file: '/d/f.jsonl', reward: 0 },
          grades: {
            hack: [makeEntry({ quotes: [{ message_index: 1, start: 0, end: 3, text: 'abc' }] })],
          },
        }),
      ];
      renderView({ samples });
      expect(screen.getByText('transcript not loaded')).toBeInTheDocument();
      expect(screen.queryByText('quote not found in transcript')).not.toBeInTheDocument();
    });
  });

  describe('filters', () => {
    it('filters bool metrics by grade value via the segmented control', () => {
      renderView();
      // Only ✓ grades: s3 (noEvidence, true) + s1 (clean, true) remain.
      fireEvent.click(within(valueFilterGroup()).getByText('✓'));
      expect(cards()).toHaveLength(2);
      expect(screen.queryByText('quote not found in transcript')).not.toBeInTheDocument();
      expect(screen.getByText('2 evidence items across 2 rollouts')).toBeInTheDocument();

      // Only ✗ grades: just s2.
      fireEvent.click(within(valueFilterGroup()).getByText('✗'));
      expect(cards()).toHaveLength(1);
      expect(screen.getByText('quote not found in transcript')).toBeInTheDocument();
      expect(screen.queryByText('The judge saved no supporting quotes.')).not.toBeInTheDocument();

      // Back to all.
      fireEvent.click(within(valueFilterGroup()).getByText('All'));
      expect(cards()).toHaveLength(3);
    });

    it('filters by audit flags via the segmented control', () => {
      renderView();
      fireEvent.click(within(flagFilterGroup()).getByText('no evidence'));
      expect(cards()).toHaveLength(1);
      expect(screen.getByText('The judge saved no supporting quotes.')).toBeInTheDocument();
      expect(screen.getByText('1 evidence items across 1 rollouts')).toBeInTheDocument();

      fireEvent.click(within(flagFilterGroup()).getByText('quote not found'));
      expect(cards()).toHaveLength(1);
      expect(screen.getByText('judge quoted:')).toBeInTheDocument();
    });
  });

  describe('open in chat', () => {
    it('fires onOpenQuote with quote coordinates from the button', () => {
      const onOpenQuote = vi.fn();
      renderView({ onOpenQuote });
      const buttons = screen.getAllByRole('button', { name: /open in chat/i });
      expect(buttons).toHaveLength(3);
      // Third card is the clean s1 item.
      fireEvent.click(buttons[2]);
      expect(onOpenQuote).toHaveBeenCalledWith(1, 1, FOUND_TEXT);
      // First card is the no-evidence s3 item -> null coordinates.
      fireEvent.click(buttons[0]);
      expect(onOpenQuote).toHaveBeenCalledWith(3, null, null);
    });

    it('fires onOpenQuote for the active card on Enter', () => {
      const onOpenQuote = vi.fn();
      renderView({ onOpenQuote });
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(onOpenQuote).toHaveBeenCalledTimes(1);
      expect(onOpenQuote).toHaveBeenCalledWith(3, null, null);
    });
  });

  describe('keyboard cursor', () => {
    it('moves the ring-highlighted active card with J/K', () => {
      renderView();
      expect(cards()[0].className).toContain('ring-2');

      fireEvent.keyDown(window, { key: 'j' });
      expect(cards()[0].className).not.toContain('ring-2');
      expect(cards()[1].className).toContain('ring-2');

      fireEvent.keyDown(window, { key: 'k' });
      expect(cards()[0].className).toContain('ring-2');
      // K at the top clamps.
      fireEvent.keyDown(window, { key: 'k' });
      expect(cards()[0].className).toContain('ring-2');
    });

    it('opens the card the cursor moved to', () => {
      const onOpenQuote = vi.fn();
      renderView({ onOpenQuote });
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(window, { key: 'Enter' });
      // Second card is s2's hallucinated quote.
      expect(onOpenQuote).toHaveBeenCalledWith(2, 1, 'fabricated quote');
    });

    it('ignores keys while typing in an input', () => {
      const onOpenQuote = vi.fn();
      render(
        <>
          <input aria-label="external input" />
          <EvidenceView samples={makeCorpus()} {...defaultProps} onOpenQuote={onOpenQuote} />
        </>,
      );
      const input = screen.getByLabelText('external input');
      fireEvent.keyDown(input, { key: 'j' });
      expect(cards()[0].className).toContain('ring-2');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onOpenQuote).not.toHaveBeenCalled();
    });
  });

  describe('audits', () => {
    it('fires onAudit from the Confirm/Dispute buttons and shows a recorded state', () => {
      const onAudit = vi.fn();
      renderView({ onAudit });
      // All three hack cards are bool -> each has Confirm + Dispute.
      expect(screen.getAllByRole('button', { name: /confirm/i })).toHaveLength(3);

      fireEvent.click(screen.getAllByRole('button', { name: /confirm/i })[0]);
      expect(onAudit).toHaveBeenCalledWith(3, 'hack', 'confirm', s3Entry);
      expect(screen.getByText('recorded ✓')).toBeInTheDocument();
      // That card's audit buttons are replaced by the recorded state.
      expect(screen.getAllByRole('button', { name: /confirm/i })).toHaveLength(2);

      fireEvent.click(screen.getAllByRole('button', { name: /dispute/i })[0]);
      expect(onAudit).toHaveBeenCalledWith(2, 'hack', 'dispute', s2Entry);
    });

    it('fires onAudit for the active card with the Y and X hotkeys', () => {
      const onAudit = vi.fn();
      renderView({ onAudit });
      fireEvent.keyDown(window, { key: 'y' });
      expect(onAudit).toHaveBeenCalledWith(3, 'hack', 'confirm', s3Entry);

      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(window, { key: 'x' });
      expect(onAudit).toHaveBeenCalledWith(2, 'hack', 'dispute', s2Entry);
      expect(onAudit).toHaveBeenCalledTimes(2);
    });

    it('does not render audit buttons for non-bool metrics', () => {
      renderView();
      fireEvent.change(screen.getByLabelText('Evidence metric'), {
        target: { value: 'aaa_score' },
      });
      expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /dispute/i })).not.toBeInTheDocument();
    });

    it('disables audits (buttons and hotkeys) when annotator is empty', () => {
      const onAudit = vi.fn();
      renderView({ onAudit, annotator: '' });
      const confirm = screen.getAllByRole('button', { name: /confirm/i })[0];
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveAttribute('title', 'Set your name in Triage mode to record audits');
      fireEvent.click(confirm);
      fireEvent.keyDown(window, { key: 'y' });
      expect(onAudit).not.toHaveBeenCalled();
      expect(screen.queryByText('recorded ✓')).not.toBeInTheDocument();
    });
  });

  describe('empty states', () => {
    it('shows a centered empty state when nothing is graded', () => {
      renderView({ samples: [makeSample({ id: 1 })] });
      expect(screen.getByText('No graded metrics yet')).toBeInTheDocument();
      expect(screen.queryByLabelText('Evidence metric')).not.toBeInTheDocument();
    });

    it('shows a no-matching-evidence state when filters exclude everything', () => {
      renderView();
      fireEvent.change(screen.getByLabelText('Evidence metric'), {
        target: { value: 'aaa_score' },
      });
      fireEvent.click(within(flagFilterGroup()).getByText('quote not found'));
      expect(screen.getByText('No matching evidence for the current filters.')).toBeInTheDocument();
      expect(screen.queryAllByTestId('evidence-card')).toHaveLength(0);
    });
  });

  describe('scope changes', () => {
    it('resets the cursor and recorded marks when samples change identity', () => {
      const onOpenQuote = vi.fn();
      const onAudit = vi.fn();
      const { rerender } = renderView({ onOpenQuote, onAudit });

      fireEvent.keyDown(window, { key: 'j' });
      expect(cards()[1].className).toContain('ring-2');
      fireEvent.keyDown(window, { key: 'y' });
      expect(screen.getByText('recorded ✓')).toBeInTheDocument();

      // Same content, new array identity (as produced by an upstream filter change).
      rerender(
        <EvidenceView
          samples={makeCorpus()}
          {...defaultProps}
          onOpenQuote={onOpenQuote}
          onAudit={onAudit}
        />,
      );
      expect(cards()[0].className).toContain('ring-2');
      expect(cards()[1].className).not.toContain('ring-2');
      expect(screen.queryByText('recorded ✓')).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Enter' });
      expect(onOpenQuote).toHaveBeenCalledWith(3, null, null);
    });
  });
});
