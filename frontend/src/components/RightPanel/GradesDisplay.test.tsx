import { render, screen, fireEvent, within } from '@testing-library/react';
import { GradesDisplay } from './GradesDisplay';
import type { SampleGrades, GradeEntry } from '../../types';

const defaultProps = {
  grades: undefined as SampleGrades | undefined,
  selectedMetric: undefined as string | undefined,
  onSelectMetric: vi.fn(),
  onScrollToQuote: vi.fn(),
  isDarkMode: false,
  currentQuoteIndex: 0,
  onQuoteIndexChange: vi.fn(),
};

function makeEntry(overrides: Partial<GradeEntry> = {}): GradeEntry {
  return {
    grade: 0.85,
    grade_type: 'float',
    quotes: [],
    explanation: '',
    model: 'gpt-4o',
    prompt_version: 'v1',
    timestamp: '2026-01-15T10:00:00',
    ...overrides,
  };
}

function makeGrades(overrides: Partial<Record<string, GradeEntry[]>> = {}): SampleGrades {
  return {
    helpfulness: [
      makeEntry({
        quotes: [
          { message_index: 1, start: 0, end: 10, text: 'Good point' },
          { message_index: 3, start: 5, end: 20, text: 'Helpful answer' },
        ],
        explanation: 'The response was helpful and addressed the question.',
      }),
    ],
    ...overrides,
  };
}

function expandHeader() {
  fireEvent.click(screen.getByText('LLM Grades').closest('button')!);
}

// The chip grid renders one button per metric whose accessible name starts
// with the metric name.
function metricChip(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

describe('GradesDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when grades is undefined', () => {
    const { container } = render(
      <GradesDisplay {...defaultProps} grades={undefined} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when grades is an empty object', () => {
    const { container } = render(
      <GradesDisplay {...defaultProps} grades={{}} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the only metric is the reserved comments one', () => {
    // Comments ride the grade rails for storage; they belong in the comments
    // drawer, not in the judge strip above the transcript.
    const { container } = render(
      <GradesDisplay
        {...defaultProps}
        grades={{ comments: [makeEntry({ grade: 'looks off', grade_type: 'freeform', model: 'human:ada' })] }}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('omits comments from the metric count when real grades exist', () => {
    render(
      <GradesDisplay
        {...defaultProps}
        grades={makeGrades({
          comments: [makeEntry({ grade: 'looks off', grade_type: 'freeform', model: 'human:ada' })],
        })}
      />
    );
    expect(screen.getByText('1 metric')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^comments/ })).not.toBeInTheDocument();
  });

  it('shows metric count in the header', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    expect(screen.getByText('LLM Grades')).toBeInTheDocument();
    expect(screen.getByText('1 metric')).toBeInTheDocument();
  });

  it('shows plural "metrics" when multiple metrics exist', () => {
    const grades = makeGrades({
      safety: [makeEntry({ grade: true, grade_type: 'bool', explanation: 'Safe content.' })],
    });
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    expect(screen.getByText('2 metrics')).toBeInTheDocument();
  });

  describe('collapsed header summary', () => {
    it('shows non-bool grade values as named chips', () => {
      render(
        <GradesDisplay {...defaultProps} grades={makeGrades()} />
      );
      // Float grade formatted to 2 decimal places, next to its metric name
      expect(screen.getByText('0.85')).toBeInTheDocument();
      expect(screen.getAllByText('helpfulness').length).toBeGreaterThan(0);
    });

    it('aggregates passing bool metrics into one count chip', () => {
      const grades: SampleGrades = {
        a: [makeEntry({ grade: true, grade_type: 'bool' })],
        b: [makeEntry({ grade: true, grade_type: 'bool' })],
        c: [makeEntry({ grade: true, grade_type: 'bool' })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expect(screen.getByText('3 ✓')).toBeInTheDocument();
      // No anonymous per-metric "✓ Yes" pills in the header
      expect(screen.queryByText('✓ Yes')).not.toBeInTheDocument();
    });

    it('surfaces failing bool metrics as named chips ahead of the pass aggregate', () => {
      const grades: SampleGrades = {
        good_one: [makeEntry({ grade: true, grade_type: 'bool' })],
        attempted_hack: [makeEntry({ grade: false, grade_type: 'bool' })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      const fail = screen.getByTitle('attempted_hack: ✗ No');
      expect(fail).toHaveTextContent('attempted_hack');
      expect(screen.getByText('1 ✓')).toBeInTheDocument();
    });

    it('compresses many failing bools into named chips plus a red overflow count', () => {
      const grades: SampleGrades = {
        f1: [makeEntry({ grade: false, grade_type: 'bool' })],
        f2: [makeEntry({ grade: false, grade_type: 'bool' })],
        f3: [makeEntry({ grade: false, grade_type: 'bool' })],
        f4: [makeEntry({ grade: false, grade_type: 'bool' })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expect(screen.getByText('+2 ✗')).toBeInTheDocument();
      expect(screen.getByTitle('f3, f4')).toBeInTheDocument();
    });

    it('shows a +N more overflow for extra non-bool metrics', () => {
      const grades: SampleGrades = {
        m1: [makeEntry({ grade: 0.1 })],
        m2: [makeEntry({ grade: 0.2 })],
        m3: [makeEntry({ grade: 0.3 })],
        m4: [makeEntry({ grade: 0.4 })],
        m5: [makeEntry({ grade: 0.5 })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expect(screen.getByText('+2 more')).toBeInTheDocument();
    });

    it('renders categorical grades — shows the chosen category value (not hidden like freeform)', () => {
      const grades: SampleGrades = {
        decision_rationale_theme: [
          makeEntry({
            grade: 'complied_on_dot_syntax_grounds',
            grade_type: 'categorical',
            explanation: 'Rejected MAP2 because spaces violate the required dot syntax.',
            model: 'gpt-5.5',
          }),
        ],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expect(screen.getAllByText('complied_on_dot_syntax_grounds').length).toBeGreaterThan(0);
      expect(screen.getByText('1 metric')).toBeInTheDocument();
    });

    it('renders int grades with a neutral color, not the float green threshold', () => {
      const grades: SampleGrades = {
        revision_count: [makeEntry({ grade: 1, grade_type: 'int' })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      const gradeEl = screen.getByText('1');
      expect(gradeEl.className).not.toMatch(/text-green/);
      expect(gradeEl.className).toContain('text-gray-700');
    });
  });

  describe('chip grid', () => {
    it('expands on header click to show one chip per metric', () => {
      const grades = makeGrades({
        safety: [makeEntry({ grade: true, grade_type: 'bool' })],
      });
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expandHeader();

      expect(metricChip('helpfulness')).toBeInTheDocument();
      expect(metricChip('safety')).toBeInTheDocument();
    });

    it('collapses again when header is clicked twice', () => {
      render(<GradesDisplay {...defaultProps} grades={makeGrades()} />);
      expandHeader();
      expect(metricChip('helpfulness')).toBeInTheDocument();
      expandHeader();
      expect(screen.queryByRole('button', { name: /^helpfulness/ })).not.toBeInTheDocument();
    });

    it('renders boolean chips as tinted glyphs with the full verdict in the tooltip', () => {
      const grades: SampleGrades = {
        passed: [makeEntry({ grade: true, grade_type: 'bool' })],
        failed: [makeEntry({ grade: false, grade_type: 'bool' })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expandHeader();

      const yes = within(metricChip('passed')).getByText('✓');
      const no = within(metricChip('failed')).getByText('✗');
      // Passes render in the app's muted teal; failures keep full red.
      expect(yes.className).toContain('text-teal-700');
      expect(no.className).toContain('text-red-600');
      // The words stay available on hover
      expect(metricChip('passed').title).toContain('✓ Yes');
      expect(metricChip('failed').title).toContain('✗ No');
    });

    it('applies float color thresholds to chip values', () => {
      const grades: SampleGrades = {
        high: [makeEntry({ grade: 0.9 })],
        mid: [makeEntry({ grade: 0.5 })],
        low: [makeEntry({ grade: 0.2 })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expandHeader();

      // Values render in both the header summary and the chip grid — every
      // instance must carry the threshold color.
      screen.getAllByText('0.90').forEach(el => expect(el.className).toContain('text-teal-700'));
      screen.getAllByText('0.50').forEach(el => expect(el.className).toContain('text-yellow-600'));
      screen.getAllByText('0.20').forEach(el => expect(el.className).toContain('text-red-600'));
    });

    it('uses dark mode color classes when isDarkMode is true', () => {
      const grades: SampleGrades = {
        accuracy: [makeEntry({ grade: 0.9 })],
      };
      render(<GradesDisplay {...defaultProps} grades={grades} isDarkMode={true} />);
      const gradeEl = screen.getByText('0.90');
      expect(gradeEl.className).toContain('text-teal-400');
    });

    it('marks chips whose grades carry quotes and omits the marker otherwise', () => {
      const grades = makeGrades({
        quoteless: [makeEntry({ grade: true, grade_type: 'bool' })],
      });
      render(<GradesDisplay {...defaultProps} grades={grades} />);
      expandHeader();

      expect(metricChip('helpfulness').title).toContain('2 quotes');
      expect(metricChip('quoteless').title).not.toContain('quote highlights');
    });

    it('calls onSelectMetric when a chip is clicked and scrolls to the first quote', () => {
      const onSelectMetric = vi.fn();
      const onScrollToQuote = vi.fn();
      render(
        <GradesDisplay
          {...defaultProps}
          grades={makeGrades()}
          onSelectMetric={onSelectMetric}
          onScrollToQuote={onScrollToQuote}
        />
      );
      expandHeader();

      fireEvent.click(metricChip('helpfulness'));
      expect(onSelectMetric).toHaveBeenCalledWith('helpfulness');
      // First quote in (message_index, start) order lives in message 1
      expect(onScrollToQuote).toHaveBeenCalledWith(1, 0);
    });

    it('deselects when the selected chip is clicked again', () => {
      const onSelectMetric = vi.fn();
      render(
        <GradesDisplay
          {...defaultProps}
          grades={makeGrades()}
          selectedMetric="helpfulness"
          onSelectMetric={onSelectMetric}
        />
      );
      expandHeader();

      const chip = metricChip('helpfulness');
      expect(chip).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(chip);
      expect(onSelectMetric).toHaveBeenCalledWith(undefined);
    });

    it('shows a hint when no metric is selected', () => {
      render(<GradesDisplay {...defaultProps} grades={makeGrades()} />);
      expandHeader();
      expect(screen.getByText(/Click a metric for its explanation/)).toBeInTheDocument();
    });
  });

  describe('detail card', () => {
    it('shows explanation, quote count, and model for the selected metric', () => {
      render(
        <GradesDisplay {...defaultProps} grades={makeGrades()} selectedMetric="helpfulness" />
      );
      expandHeader();

      expect(screen.getByText('Explanation:')).toBeInTheDocument();
      expect(
        screen.getByText('The response was helpful and addressed the question.')
      ).toBeInTheDocument();
      expect(
        screen.getByText((_content, element) =>
          element?.tagName === 'SPAN' && /2 quotes/.test(element.textContent ?? '')
        )
      ).toBeInTheDocument();
      expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
    });

    it('displays singular quote when there is exactly one', () => {
      const grades: SampleGrades = {
        helpfulness: [
          makeEntry({
            grade: 0.9,
            quotes: [{ message_index: 1, start: 0, end: 5, text: 'Great' }],
          }),
        ],
      };
      render(
        <GradesDisplay {...defaultProps} grades={grades} selectedMetric="helpfulness" />
      );
      expandHeader();

      expect(
        screen.getByText((_content, element) =>
          element?.tagName === 'SPAN' && /1 quote[^s]/.test(element.textContent ?? '')
        )
      ).toBeInTheDocument();
    });

    it('renders freeform grades as prose with an Answer label and expand toggle', () => {
      const longAnswer = 'The model shows signs of reward hacking: it edited a test fixture so that the evaluation script would pass, rather than fixing the underlying behavior.';
      const grades: SampleGrades = {
        analysis: [makeEntry({ grade: longAnswer, grade_type: 'freeform' })],
      };
      render(
        <GradesDisplay {...defaultProps} grades={grades} selectedMetric="analysis" />
      );
      expandHeader();

      expect(screen.getByText('freeform')).toBeInTheDocument();
      expect(screen.getByText('Answer:')).toBeInTheDocument();
      expect(screen.getByText(/reward hacking/)).toBeInTheDocument();
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });

    it('renders empty freeform grade with (empty) placeholder', () => {
      const grades: SampleGrades = {
        analysis: [makeEntry({ grade: '', grade_type: 'freeform' })],
      };
      render(
        <GradesDisplay {...defaultProps} grades={grades} selectedMetric="analysis" />
      );
      expandHeader();
      expect(screen.getByText('(empty)')).toBeInTheDocument();
    });

    it('truncates long explanations and toggles with Show more / Show less', () => {
      const grades: SampleGrades = {
        helpfulness: [makeEntry({ grade: 0.8, explanation: 'A'.repeat(200) })],
      };
      render(
        <GradesDisplay {...defaultProps} grades={grades} selectedMetric="helpfulness" />
      );
      expandHeader();

      expect(screen.getByText('Show more')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Show more'));
      expect(screen.getByText('Show less')).toBeInTheDocument();
    });

    it('closes via the ✕ button, clearing the selection', () => {
      const onSelectMetric = vi.fn();
      render(
        <GradesDisplay
          {...defaultProps}
          grades={makeGrades()}
          selectedMetric="helpfulness"
          onSelectMetric={onSelectMetric}
        />
      );
      expandHeader();

      fireEvent.click(screen.getByRole('button', { name: 'Close grade details' }));
      expect(onSelectMetric).toHaveBeenCalledWith(undefined);
    });

    it('does not show quote navigation when no metric is selected', () => {
      render(<GradesDisplay {...defaultProps} grades={makeGrades()} />);
      expandHeader();

      expect(screen.queryByTitle('Previous quote')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Next quote')).not.toBeInTheDocument();
    });

    it('shows quote navigation arrows when metric is selected and has multiple quotes', () => {
      render(
        <GradesDisplay
          {...defaultProps}
          grades={makeGrades()}
          selectedMetric="helpfulness"
          currentQuoteIndex={0}
        />
      );
      expandHeader();

      expect(screen.getByTitle('Previous quote')).toBeInTheDocument();
      expect(screen.getByTitle('Next quote')).toBeInTheDocument();
      expect(screen.getByText('1/2')).toBeInTheDocument();
    });

    it('calls onQuoteIndexChange when navigating quotes', () => {
      const onQuoteIndexChange = vi.fn();
      render(
        <GradesDisplay
          {...defaultProps}
          grades={makeGrades()}
          selectedMetric="helpfulness"
          currentQuoteIndex={0}
          onQuoteIndexChange={onQuoteIndexChange}
        />
      );
      expandHeader();

      fireEvent.click(screen.getByTitle('Next quote'));
      expect(onQuoteIndexChange).toHaveBeenCalledWith(1);
    });
  });

  describe('run history', () => {
    // Two grading runs for the same metric: an older one (no quotes) and the
    // latest one (with quotes).
    function makeMultiRunGrades(): SampleGrades {
      return {
        helpfulness: [
          makeEntry({
            grade: 0.3,
            explanation: 'Old run.',
            model: 'gpt-4o-mini',
            timestamp: '2026-01-10T09:00:00',
          }),
          makeEntry({
            grade: 0.85,
            quotes: [{ message_index: 1, start: 0, end: 10, text: 'Good point' }],
            explanation: 'New run.',
          }),
        ],
      };
    }

    it('marks multi-run chips with a run count', () => {
      render(<GradesDisplay {...defaultProps} grades={makeMultiRunGrades()} />);
      expandHeader();
      expect(within(metricChip('helpfulness')).getByText('×2')).toBeInTheDocument();
    });

    it('shows a run counter defaulting to the latest run when a metric has multiple entries', () => {
      render(
        <GradesDisplay {...defaultProps} grades={makeMultiRunGrades()} selectedMetric="helpfulness" />
      );
      expandHeader();

      expect(screen.getByText(/run 2 of 2/)).toBeInTheDocument();
      expect(screen.getByText('New run.')).toBeInTheDocument();
    });

    it('does not show run navigation for a single-entry metric', () => {
      render(
        <GradesDisplay {...defaultProps} grades={makeGrades()} selectedMetric="helpfulness" />
      );
      expandHeader();

      expect(screen.queryByRole('button', { name: 'Previous run' })).not.toBeInTheDocument();
      expect(screen.queryByText(/run 1 of 1/)).not.toBeInTheDocument();
    });

    it('navigates to an older run with the chevrons, showing that run\'s value and explanation', () => {
      render(
        <GradesDisplay {...defaultProps} grades={makeMultiRunGrades()} selectedMetric="helpfulness" />
      );
      expandHeader();

      fireEvent.click(screen.getByRole('button', { name: 'Previous run' }));
      expect(screen.getByText(/run 1 of 2/)).toBeInTheDocument();
      expect(screen.getByText('0.30')).toBeInTheDocument();
      expect(screen.getByText('Old run.')).toBeInTheDocument();

      // Back to the latest run
      fireEvent.click(screen.getByRole('button', { name: 'Next run' }));
      expect(screen.getByText(/run 2 of 2/)).toBeInTheDocument();
      expect(screen.getByText('New run.')).toBeInTheDocument();
    });

    it('flags that quotes come from the latest run when browsing an older one', () => {
      render(
        <GradesDisplay {...defaultProps} grades={makeMultiRunGrades()} selectedMetric="helpfulness" />
      );
      expandHeader();

      expect(screen.queryByText(/quotes are from the latest run/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Previous run' }));
      expect(screen.getByText(/quotes are from the latest run/)).toBeInTheDocument();
    });

    it('resets to the latest run when the grades prop changes identity', () => {
      const { rerender } = render(
        <GradesDisplay {...defaultProps} grades={makeMultiRunGrades()} selectedMetric="helpfulness" />
      );
      expandHeader();

      fireEvent.click(screen.getByRole('button', { name: 'Previous run' }));
      expect(screen.getByText(/run 1 of 2/)).toBeInTheDocument();

      // New grades object (e.g. a different sample) — back to the latest run
      rerender(
        <GradesDisplay {...defaultProps} grades={makeMultiRunGrades()} selectedMetric="helpfulness" />
      );
      expect(screen.getByText(/run 2 of 2/)).toBeInTheDocument();
    });
  });

  describe('expanded pane sizing and explanation reveal', () => {
    it('caps the expanded grade list at 40vh instead of the old fixed 12rem', () => {
      const { container } = render(<GradesDisplay {...defaultProps} grades={makeGrades()} />);
      expandHeader();

      const pane = container.querySelector('[class*="max-h-"]') as HTMLElement;
      expect(pane).not.toBeNull();
      expect(pane.className).toContain('max-h-[40vh]');
      expect(pane.className).not.toContain('max-h-48');
    });

    it('scrolls a newly expanded explanation into view (block: nearest)', () => {
      const spy = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = spy;
      try {
        const grades: SampleGrades = {
          helpfulness: [makeEntry({ grade: 0.8, explanation: 'B'.repeat(300) })],
        };
        render(
          <GradesDisplay {...defaultProps} grades={grades} selectedMetric="helpfulness" />
        );
        expandHeader();
        expect(spy).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText('Show more'));
        expect(spy).toHaveBeenCalledWith({ block: 'nearest' });

        // Collapsing back does not scroll again.
        spy.mockClear();
        fireEvent.click(screen.getByText('Show less'));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });
  });
});
