import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi } from 'vitest';
import { TriageBar, type TriageBarProps } from './index';
import { TRIAGE_VERDICTS } from '../../utils/humanGrades';

function makeProps(overrides: Partial<TriageBarProps> = {}): TriageBarProps {
  return {
    isDarkMode: false,
    annotator: 'alice',
    onAnnotatorChange: vi.fn(),
    verdicts: TRIAGE_VERDICTS,
    currentVerdict: null,
    currentNote: '',
    noteDraft: '',
    onNoteDraftChange: vi.fn(),
    reviewedCount: 3,
    totalCount: 10,
    verdictCounts: { hack: 7, clean: 12, interesting: 0, unsure: 5 },
    hasSelection: true,
    onVerdict: vi.fn(),
    onJumpToUnreviewed: vi.fn(),
    saveError: null,
    onClose: vi.fn(),
    ...overrides,
  };
}

const NAME_PLACEHOLDER = 'Your name (stored locally, tags your verdicts)';
const NOTE_PLACEHOLDER = 'note (optional)…';

describe('TriageBar', () => {
  describe('first-run annotator gate', () => {
    it('disables all verdict buttons until the annotator is set, with an explanatory title', () => {
      render(<TriageBar {...makeProps({ annotator: '' })} />);
      for (const label of TRIAGE_VERDICTS) {
        const btn = screen.getByTestId(`verdict-${label}`);
        expect(btn).toBeDisabled();
        expect(btn.getAttribute('title')).toMatch(/set your name/i);
      }
      expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toBeInTheDocument();
    });

    it('Save is disabled for a blank name and calls onAnnotatorChange with the trimmed name', () => {
      const onAnnotatorChange = vi.fn();
      render(<TriageBar {...makeProps({ annotator: '', onAnnotatorChange })} />);
      const save = screen.getByRole('button', { name: 'Save' });
      expect(save).toBeDisabled();

      const input = screen.getByPlaceholderText(NAME_PLACEHOLDER);
      fireEvent.change(input, { target: { value: '  Alice  ' } });
      fireEvent.click(save);
      expect(onAnnotatorChange).toHaveBeenCalledWith('Alice');
    });

    it('enables verdict buttons and shows the "as <name>" chip once the annotator prop is set', () => {
      const props = makeProps({ annotator: '' });
      const { rerender } = render(<TriageBar {...props} />);
      expect(screen.getByTestId('verdict-hack')).toBeDisabled();

      rerender(<TriageBar {...props} annotator="Alice" />);
      expect(screen.getByTestId('verdict-hack')).toBeEnabled();
      expect(screen.getByRole('button', { name: 'as Alice' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(NAME_PLACEHOLDER)).not.toBeInTheDocument();
    });

    it('clicking the "as <name>" chip swaps back to the input prefilled with the name', () => {
      render(<TriageBar {...makeProps({ annotator: 'alice' })} />);
      fireEvent.click(screen.getByRole('button', { name: 'as alice' }));
      const input = screen.getByPlaceholderText(NAME_PLACEHOLDER);
      expect(input).toHaveValue('alice');
    });
  });

  describe('verdict buttons', () => {
    it('clicking a verdict calls onVerdict with that label', () => {
      const onVerdict = vi.fn();
      render(<TriageBar {...makeProps({ onVerdict })} />);
      fireEvent.click(screen.getByTestId('verdict-clean'));
      expect(onVerdict).toHaveBeenCalledTimes(1);
      expect(onVerdict).toHaveBeenCalledWith('clean');
    });

    it('marks only the current verdict as aria-pressed', () => {
      render(<TriageBar {...makeProps({ currentVerdict: 'hack' })} />);
      expect(screen.getByTestId('verdict-hack')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('verdict-clean')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByTestId('verdict-unsure')).toHaveAttribute('aria-pressed', 'false');
    });

    it('renders the hotkey number as a <kbd> and the per-verdict count', () => {
      render(<TriageBar {...makeProps()} />);
      const hack = within(screen.getByTestId('verdict-hack'));
      // TRIAGE_VERDICTS[0] === 'hack' → hotkey 1, count 7.
      expect(hack.getByText('1').tagName).toBe('KBD');
      expect(hack.getByText('7')).toBeInTheDocument();
      const clean = within(screen.getByTestId('verdict-clean'));
      expect(clean.getByText('2').tagName).toBe('KBD');
      expect(clean.getByText('12')).toBeInTheDocument();
    });

    it('defaults a missing verdictCounts key to 0', () => {
      render(<TriageBar {...makeProps({ verdictCounts: {} })} />);
      expect(within(screen.getByTestId('verdict-hack')).getByText('0')).toBeInTheDocument();
    });

    it('disables verdict buttons when there is no selection', () => {
      render(<TriageBar {...makeProps({ hasSelection: false })} />);
      for (const label of TRIAGE_VERDICTS) {
        expect(screen.getByTestId(`verdict-${label}`)).toBeDisabled();
      }
    });
  });

  describe('note draft', () => {
    it('round-trips: shows noteDraft and reports edits via onNoteDraftChange', () => {
      const onNoteDraftChange = vi.fn();
      render(<TriageBar {...makeProps({ noteDraft: 'sus tool call', onNoteDraftChange })} />);
      const input = screen.getByPlaceholderText(NOTE_PLACEHOLDER);
      expect(input).toHaveValue('sus tool call');
      fireEvent.change(input, { target: { value: 'edited note' } });
      expect(onNoteDraftChange).toHaveBeenCalledWith('edited note');
    });

    it('Escape blurs the note input without propagating to ancestors', () => {
      const outerKeyDown = vi.fn();
      render(
        <div onKeyDown={outerKeyDown}>
          <TriageBar {...makeProps()} />
        </div>,
      );
      const input = screen.getByPlaceholderText(NOTE_PLACEHOLDER);
      input.focus();
      expect(document.activeElement).toBe(input);
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(outerKeyDown).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(input);
    });

    it('shows the stored note as a chip with the full note in the title', () => {
      const note = 'model rewrote the unit test to always pass';
      render(<TriageBar {...makeProps({ currentVerdict: 'hack', currentNote: note })} />);
      expect(screen.getByTitle(note)).toHaveTextContent(note);
    });

    it('hides the stored-note chip when the sample is unreviewed', () => {
      const note = 'left over note';
      render(<TriageBar {...makeProps({ currentVerdict: null, currentNote: note })} />);
      expect(screen.queryByTitle(note)).not.toBeInTheDocument();
    });
  });

  describe('progress and navigation', () => {
    it('renders reviewed/total text and a proportional progress fill', () => {
      render(<TriageBar {...makeProps({ reviewedCount: 3, totalCount: 10 })} />);
      expect(screen.getByText('3/10 reviewed')).toBeInTheDocument();
      expect(screen.getByTestId('triage-progress-fill')).toHaveStyle({ width: '30%' });
    });

    it('renders a 0% fill when totalCount is 0 (no divide-by-zero)', () => {
      render(<TriageBar {...makeProps({ reviewedCount: 0, totalCount: 0 })} />);
      expect(screen.getByText('0/0 reviewed')).toBeInTheDocument();
      expect(screen.getByTestId('triage-progress-fill')).toHaveStyle({ width: '0%' });
    });

    it('jump button calls onJumpToUnreviewed and is disabled when everything is reviewed', () => {
      const onJumpToUnreviewed = vi.fn();
      const props = makeProps({ onJumpToUnreviewed });
      const { rerender } = render(<TriageBar {...props} />);
      const jump = screen.getByRole('button', { name: 'Next unreviewed' });
      fireEvent.click(jump);
      expect(onJumpToUnreviewed).toHaveBeenCalledTimes(1);

      rerender(<TriageBar {...props} reviewedCount={10} totalCount={10} />);
      expect(screen.getByRole('button', { name: 'Next unreviewed' })).toBeDisabled();
    });
  });

  describe('errors and exit', () => {
    it('renders a prominent inline chip when saveError is set', () => {
      render(<TriageBar {...makeProps({ saveError: 'Save failed: 500' })} />);
      expect(screen.getByRole('alert')).toHaveTextContent('Save failed: 500');
    });

    it('renders no alert when saveError is null', () => {
      render(<TriageBar {...makeProps({ saveError: null })} />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('close button calls onClose', () => {
      const onClose = vi.fn();
      render(<TriageBar {...makeProps({ onClose })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Exit triage mode' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
