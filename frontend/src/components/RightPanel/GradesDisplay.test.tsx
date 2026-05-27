import { render, screen, fireEvent } from '@testing-library/react';
import { GradesDisplay } from './GradesDisplay';
import type { SampleGrades } from '../../types';

const defaultProps = {
  grades: undefined as SampleGrades | undefined,
  selectedMetric: undefined as string | undefined,
  onSelectMetric: vi.fn(),
  onScrollToQuote: vi.fn(),
  isDarkMode: false,
  currentQuoteIndex: 0,
  onQuoteIndexChange: vi.fn(),
};

function makeGrades(overrides: Partial<Record<string, unknown>> = {}): SampleGrades {
  return {
    helpfulness: [
      {
        grade: 0.85,
        grade_type: 'float',
        quotes: [
          { message_index: 1, start: 0, end: 10, text: 'Good point' },
          { message_index: 3, start: 5, end: 20, text: 'Helpful answer' },
        ],
        explanation: 'The response was helpful and addressed the question.',
        model: 'gpt-4o',
        prompt_version: 'v1',
        timestamp: '2026-01-15T10:00:00',
      },
    ],
    ...overrides,
  };
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

  it('shows metric count in the header', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    expect(screen.getByText('LLM Grades (1 metric)')).toBeInTheDocument();
  });

  it('renders freeform grades as prose (truncated preview in header, full text when expanded)', () => {
    const longAnswer = 'The model shows signs of reward hacking: it edited a test fixture so that the evaluation script would pass, rather than fixing the underlying behavior.';
    const grades: SampleGrades = {
      analysis: [
        {
          grade: longAnswer,
          grade_type: 'freeform',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(<GradesDisplay {...defaultProps} grades={grades} />);

    // Expand to see the full answer block
    fireEvent.click(screen.getByText(/LLM Grades/));

    // A "freeform" type badge is shown in the metric header (instead of a numeric/bool pill).
    expect(screen.getByText('freeform')).toBeInTheDocument();
    // The body uses an "Answer:" label (not "Explanation:") for freeform grades.
    expect(screen.getByText('Answer:')).toBeInTheDocument();
    // The answer text is present and the expand toggle appears because it's >150 chars.
    expect(screen.getByText(/reward hacking/)).toBeInTheDocument();
    expect(screen.getByText('Show more')).toBeInTheDocument();
  });

  it('renders empty freeform grade with (empty) placeholder', () => {
    const grades: SampleGrades = {
      analysis: [
        {
          grade: '',
          grade_type: 'freeform',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(<GradesDisplay {...defaultProps} grades={grades} />);
    fireEvent.click(screen.getByText(/LLM Grades/));
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('shows plural "metrics" when multiple metrics exist', () => {
    const grades = makeGrades({
      safety: [
        {
          grade: true,
          grade_type: 'bool',
          quotes: [],
          explanation: 'Safe content.',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    });
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    expect(screen.getByText('LLM Grades (2 metrics)')).toBeInTheDocument();
  });

  it('shows grade preview values in the collapsed header', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    // Float grade formatted to 2 decimal places
    expect(screen.getByText('0.85')).toBeInTheDocument();
  });

  it('expands on header click to show metric details', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    // Before expanding, metric name should not be visible in expanded section
    // (it may appear in preview). Click the header button.
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    expect(header).not.toBeNull();
    fireEvent.click(header!);

    // After expanding, the metric name and "Show quotes" button should be visible
    expect(screen.getByText('helpfulness')).toBeInTheDocument();
    expect(screen.getByText('Show quotes')).toBeInTheDocument();
  });

  it('collapses again when header is clicked twice', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    // Expand
    fireEvent.click(header!);
    expect(screen.getByText('Show quotes')).toBeInTheDocument();
    // Collapse
    fireEvent.click(header!);
    expect(screen.queryByText('Show quotes')).not.toBeInTheDocument();
  });

  it('formats boolean true grade as checkmark yes', () => {
    const grades: SampleGrades = {
      safety: [
        {
          grade: true,
          grade_type: 'bool',
          quotes: [],
          explanation: 'Safe content.',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    // The preview in the header should show the formatted bool
    expect(screen.getByText(/✓ Yes/)).toBeInTheDocument();
  });

  it('formats boolean false grade as cross no', () => {
    const grades: SampleGrades = {
      safety: [
        {
          grade: false,
          grade_type: 'bool',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    expect(screen.getByText(/✗ No/)).toBeInTheDocument();
  });

  it('formats float grade to two decimal places', () => {
    const grades: SampleGrades = {
      accuracy: [
        {
          grade: 0.7,
          grade_type: 'float',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    expect(screen.getByText('0.70')).toBeInTheDocument();
  });

  it('applies green color class for high float grade', () => {
    const grades: SampleGrades = {
      accuracy: [
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
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    const gradeEl = screen.getByText('0.90');
    expect(gradeEl.className).toContain('text-green-600');
  });

  it('applies yellow color class for medium float grade', () => {
    const grades: SampleGrades = {
      accuracy: [
        {
          grade: 0.5,
          grade_type: 'float',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    const gradeEl = screen.getByText('0.50');
    expect(gradeEl.className).toContain('text-yellow-600');
  });

  it('applies red color class for low float grade', () => {
    const grades: SampleGrades = {
      accuracy: [
        {
          grade: 0.2,
          grade_type: 'float',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    const gradeEl = screen.getByText('0.20');
    expect(gradeEl.className).toContain('text-red-600');
  });

  it('applies green color for boolean true grade', () => {
    const grades: SampleGrades = {
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
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    const gradeEl = screen.getByText(/✓ Yes/);
    expect(gradeEl.className).toContain('text-green-600');
  });

  it('applies red color for boolean false grade', () => {
    const grades: SampleGrades = {
      safety: [
        {
          grade: false,
          grade_type: 'bool',
          quotes: [],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    const gradeEl = screen.getByText(/✗ No/);
    expect(gradeEl.className).toContain('text-red-600');
  });

  it('displays quote count in expanded view', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    // Expand
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    // The quote count text is split across elements (icon span + text nodes),
    // so use a function matcher to check the parent span's textContent
    expect(
      screen.getByText((_content, element) =>
        element?.tagName === 'SPAN' && /2 quotes/.test(element.textContent ?? '')
      )
    ).toBeInTheDocument();
  });

  it('displays singular quote when there is exactly one', () => {
    const grades: SampleGrades = {
      helpfulness: [
        {
          grade: 0.9,
          grade_type: 'float',
          quotes: [{ message_index: 1, start: 0, end: 5, text: 'Great' }],
          explanation: '',
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    expect(
      screen.getByText((_content, element) =>
        element?.tagName === 'SPAN' && /1 quote[^s]/.test(element.textContent ?? '')
      )
    ).toBeInTheDocument();
  });

  it('displays model name in expanded view', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    // Expand
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
  });

  it('displays explanation text in expanded view', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    // Expand
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    expect(screen.getByText('Explanation:')).toBeInTheDocument();
    expect(
      screen.getByText('The response was helpful and addressed the question.')
    ).toBeInTheDocument();
  });

  it('truncates long explanations and shows "Show more" button', () => {
    const longExplanation = 'A'.repeat(200);
    const grades: SampleGrades = {
      helpfulness: [
        {
          grade: 0.8,
          grade_type: 'float',
          quotes: [],
          explanation: longExplanation,
          model: 'gpt-4o',
          prompt_version: 'v1',
          timestamp: '2026-01-15T10:00:00',
        },
      ],
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} />
    );
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    // Should show truncated text (150 chars + ...)
    expect(screen.getByText('Show more')).toBeInTheDocument();

    // Click "Show more" to expand
    fireEvent.click(screen.getByText('Show more'));
    expect(screen.getByText('Show less')).toBeInTheDocument();
  });

  it('calls onSelectMetric when "Show quotes" is clicked', () => {
    const onSelectMetric = vi.fn();
    render(
      <GradesDisplay
        {...defaultProps}
        grades={makeGrades()}
        onSelectMetric={onSelectMetric}
      />
    );
    // Expand
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    fireEvent.click(screen.getByText('Show quotes'));
    expect(onSelectMetric).toHaveBeenCalledWith('helpfulness');
  });

  it('shows "Hide quotes" button when metric is selected', () => {
    render(
      <GradesDisplay
        {...defaultProps}
        grades={makeGrades()}
        selectedMetric="helpfulness"
      />
    );
    // Expand
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    expect(screen.getByText('Hide quotes')).toBeInTheDocument();
  });

  it('calls onSelectMetric with undefined when "Hide quotes" is clicked', () => {
    const onSelectMetric = vi.fn();
    render(
      <GradesDisplay
        {...defaultProps}
        grades={makeGrades()}
        selectedMetric="helpfulness"
        onSelectMetric={onSelectMetric}
      />
    );
    // Expand
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    fireEvent.click(screen.getByText('Hide quotes'));
    expect(onSelectMetric).toHaveBeenCalledWith(undefined);
  });

  it('uses dark mode color classes when isDarkMode is true', () => {
    const grades: SampleGrades = {
      accuracy: [
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
    };
    render(
      <GradesDisplay {...defaultProps} grades={grades} isDarkMode={true} />
    );
    const gradeEl = screen.getByText('0.90');
    expect(gradeEl.className).toContain('text-green-400');
  });

  it('does not show quote navigation when no metric is selected', () => {
    render(
      <GradesDisplay {...defaultProps} grades={makeGrades()} />
    );
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

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
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

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
    const header = screen.getByText('LLM Grades (1 metric)').closest('button');
    fireEvent.click(header!);

    fireEvent.click(screen.getByTitle('Next quote'));
    expect(onQuoteIndexChange).toHaveBeenCalledWith(1);
  });
});
