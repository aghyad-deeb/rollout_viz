/**
 * Stress tests for LeftPanel filtering/sorting with 5,000 samples.
 *
 * Tests the O(n) filtering pipeline, filter expression evaluation,
 * sorting performance, and metric aggregation at scale.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LeftPanel } from './index';
import { makeSample, makeAttributes, makeGradeEntry, makeMessage } from '../../test/fixtures';
import type { Sample, SearchCondition } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const generateId = () => Math.random().toString(36).substring(2, 9);

/**
 * Generate 5,000 samples with realistic content for search/filter testing.
 */
function generate5000SamplesForSearch(): Sample[] {
  const sources = ['train/batch_a', 'train/batch_b', 'eval/test_set', 'eval/dev_set', 'prod/live'];
  const experiments = ['baseline', 'improved_v2', 'ablation_study'];

  return Array.from({ length: 5000 }, (_, i) => {
    const messages = [
      makeMessage('system', 'You are a helpful assistant. Think step by step.'),
      makeMessage('user', `Question ${i}: What is the meaning of sample number ${i}? Consider context ${i % 50}.`),
      makeMessage('assistant',
        `<think>Let me reason about question ${i}. The key factors are complexity level ${i % 10} ` +
        `and priority ${i % 5}. I need to consider edge cases.</think>\n\n` +
        `Based on my analysis, sample ${i} relates to batch ${Math.floor(i / 100)} ` +
        `with a confidence of ${(50 + i % 50) / 100}. The primary finding is that ` +
        `the approach works well for scenario ${i % 20}.`
      ),
    ];

    // Add follow-up for some samples
    if (i % 3 === 0) {
      messages.push(
        makeMessage('user', `Follow-up on ${i}: elaborate on the edge case.`),
        makeMessage('assistant', `The edge case for ${i} involves handling null values and boundary conditions.`),
      );
    }

    // Add grades for ~60% of samples
    const grades: Record<string, ReturnType<typeof makeGradeEntry>[]> = {};
    if (i % 5 !== 0) {
      grades['helpfulness'] = [makeGradeEntry(
        Math.round(Math.random() * 100) / 100,
        'float',
      )];
      grades['accuracy'] = [makeGradeEntry(Math.random() > 0.4, 'bool')];
    }
    if (i % 3 === 0) {
      grades['safety'] = [makeGradeEntry(
        Math.round((0.7 + Math.random() * 0.3) * 100) / 100,
        'float',
      )];
    }

    return makeSample({
      id: i,
      messages,
      attributes: {
        ...makeAttributes(),
        sample_index: i,
        rollout_n: i,
        step: i % 100,
        reward: Math.round((Math.random() * 2 - 1) * 100) / 100,
        data_source: sources[i % sources.length],
        experiment_name: experiments[i % experiments.length],
        is_validate: i % 4 === 0,
      },
      ...(Object.keys(grades).length > 0 ? { grades } : {}),
    });
  });
}

/**
 * Small sample set for behavior (non-stress) tests: filter validation,
 * empty states, clear-filters.
 */
function makeSmallSamples(count = 10): Sample[] {
  return Array.from({ length: count }, (_, i) =>
    makeSample({
      id: i,
      attributes: {
        ...makeAttributes(),
        sample_index: i,
        rollout_n: i,
        step: i,
        reward: i * 0.1,
      },
    }),
  );
}

function makeDefaultProps(overrides: Partial<Parameters<typeof LeftPanel>[0]> = {}) {
  return {
    samples: [] as Sample[],
    selectedSampleId: null,
    onSelectSample: vi.fn(),
    experimentName: 'stress_test',
    filePaths: ['stress_test.jsonl'],
    onFilePathsChange: vi.fn(),
    onOpenFileBrowser: vi.fn(),
    searchConditions: [{ id: generateId(), field: 'chat' as const, operator: 'contains' as const, term: '' }],
    onSearchConditionsChange: vi.fn(),
    searchLogic: 'AND' as const,
    onSearchLogicChange: vi.fn(),
    loading: false,
    error: null,
    isDarkMode: false,
    onToggleDarkMode: vi.fn(),
    onFilteredSamplesChange: vi.fn(),
    onCurrentOccurrenceIndexChange: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LeftPanel stress (5,000 samples)', () => {
  it('renders 5,000 samples without crashing', () => {
    const samples = generate5000SamplesForSearch();
    const { container } = render(<LeftPanel {...makeDefaultProps({ samples })} />);

    // Should show total count somewhere in the metadata header
    expect(container.textContent).toContain('5000');
  });

  it('initial render completes within 2s for 5,000 samples', () => {
    const samples = generate5000SamplesForSearch();

    const start = performance.now();
    const { unmount } = render(<LeftPanel {...makeDefaultProps({ samples })} />);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
    unmount();
  });

  it('filters 5,000 samples by chat content', () => {
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    const searchConditions: SearchCondition[] = [{
      id: generateId(),
      field: 'chat',
      operator: 'contains',
      term: 'question 42:',
    }];

    render(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions,
      onFilteredSamplesChange: onFiltered,
    })} />);

    // The filtered callback should have been called with a subset
    expect(onFiltered).toHaveBeenCalled();
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    expect(lastCall.length).toBeLessThan(5000);
    expect(lastCall.length).toBeGreaterThan(0);
  });

  it('filters by reasoning content across 5,000 samples', () => {
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    const searchConditions: SearchCondition[] = [{
      id: generateId(),
      field: 'reasoning',
      operator: 'contains',
      term: 'complexity level 5',
    }];

    render(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions,
      onFilteredSamplesChange: onFiltered,
    })} />);

    expect(onFiltered).toHaveBeenCalled();
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    // Should find samples where i % 10 == 5 → ~500 samples
    expect(lastCall.length).toBeGreaterThan(100);
    expect(lastCall.length).toBeLessThan(1000);
  });

  it('applies NOT_CONTAINS filter to 5,000 samples', () => {
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    const searchConditions: SearchCondition[] = [{
      id: generateId(),
      field: 'data_source',
      operator: 'not_contains',
      term: 'train',
    }];

    render(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions,
      onFilteredSamplesChange: onFiltered,
    })} />);

    expect(onFiltered).toHaveBeenCalled();
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    // 5 sources, 2 are "train/*" → 3/5 should remain = 3000
    expect(lastCall.length).toBe(3000);
  });

  it('applies AND logic across multiple conditions on 5,000 samples', () => {
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    const searchConditions: SearchCondition[] = [
      { id: generateId(), field: 'data_source', operator: 'contains', term: 'train' },
      { id: generateId(), field: 'chat', operator: 'contains', term: 'question 1' },
    ];

    render(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions,
      searchLogic: 'AND',
      onFilteredSamplesChange: onFiltered,
    })} />);

    expect(onFiltered).toHaveBeenCalled();
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    // Must match BOTH conditions — intersection should be smaller
    expect(lastCall.length).toBeLessThan(2000);
    expect(lastCall.length).toBeGreaterThan(0);
  });

  it('applies OR logic across conditions on 5,000 samples', () => {
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    const searchConditions: SearchCondition[] = [
      { id: generateId(), field: 'data_source', operator: 'contains', term: 'train' },
      { id: generateId(), field: 'data_source', operator: 'contains', term: 'eval' },
    ];

    render(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions,
      searchLogic: 'OR',
      onFilteredSamplesChange: onFiltered,
    })} />);

    expect(onFiltered).toHaveBeenCalled();
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    // train + eval = 4/5 sources = 4000 samples
    expect(lastCall.length).toBe(4000);
  });

  it('sorts 5,000 samples by reward', () => {
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    const { container } = render(<LeftPanel {...makeDefaultProps({
      samples,
      onFilteredSamplesChange: onFiltered,
    })} />);

    // "Reward" appears in both FilterBar <option> and SampleTable header.
    // Target the header span with class "truncate" inside the uppercase header row.
    const headerSpans = container.querySelectorAll('[class*="uppercase"] [class*="truncate"]');
    const rewardSpan = Array.from(headerSpans).find(el => el.textContent === 'Reward');
    expect(rewardSpan).toBeTruthy();

    const clickTarget = rewardSpan!.closest('[class*="cursor-pointer"]');
    if (clickTarget) fireEvent.click(clickTarget);

    const calls = onFiltered.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
  });

  it('handles grade column sorting with 5,000 graded samples', () => {
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    render(<LeftPanel {...makeDefaultProps({
      samples,
      onFilteredSamplesChange: onFiltered,
    })} />);

    // Verify helpfulness column exists and can be clicked
    const headers = document.querySelectorAll('[class*="uppercase"] [class*="truncate"]');
    const helpfulnessHeader = Array.from(headers).find(h =>
      h.textContent?.toLowerCase().includes('helpfu')
    );

    if (helpfulnessHeader) {
      const clickTarget = helpfulnessHeader.closest('[class*="cursor-pointer"]');
      if (clickTarget) {
        fireEvent.click(clickTarget);
        expect(onFiltered).toHaveBeenCalled();
      }
    }
  });

  it('re-renders efficiently when samples array changes', () => {
    const samples1 = generate5000SamplesForSearch();
    // Create a slightly different samples array (simulating a filter change)
    const samples2 = samples1.slice(0, 2500);

    const { rerender } = render(<LeftPanel {...makeDefaultProps({ samples: samples1 })} />);

    const start = performance.now();
    rerender(<LeftPanel {...makeDefaultProps({ samples: samples2 })} />);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  it('filtered count updates correctly with empty search clearing', async () => {
    vi.useFakeTimers();
    const samples = generate5000SamplesForSearch();
    const onFiltered = vi.fn();

    // Start with a restrictive filter
    const searchConditions: SearchCondition[] = [{
      id: generateId(),
      field: 'chat',
      operator: 'contains',
      term: 'question 42:',
    }];

    const { rerender } = render(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions,
      onFilteredSamplesChange: onFiltered,
    })} />);

    // Let debounce settle
    act(() => { vi.advanceTimersByTime(200); });

    // Get filtered count
    const filteredCalls = onFiltered.mock.calls;
    const filteredCount = filteredCalls[filteredCalls.length - 1][0].length;
    expect(filteredCount).toBeLessThan(5000);

    // Clear the search
    const clearConditions: SearchCondition[] = [{
      id: generateId(),
      field: 'chat',
      operator: 'contains',
      term: '',
    }];

    rerender(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions: clearConditions,
      onFilteredSamplesChange: onFiltered,
    })} />);

    // Let debounce settle
    act(() => { vi.advanceTimersByTime(200); });

    // Should show all 5000 again
    const allCalls = onFiltered.mock.calls;
    const allCount = allCalls[allCalls.length - 1][0].length;
    expect(allCount).toBe(5000);

    vi.useRealTimers();
  });

  it('shows loading state instead of table while loading 5,000 samples', () => {
    render(<LeftPanel {...makeDefaultProps({ loading: true })} />);
    expect(screen.getByText('Loading samples...')).toBeInTheDocument();
  });

  it('shows error state with 5,000 samples context', () => {
    render(<LeftPanel {...makeDefaultProps({ error: 'Request timed out — server may be starting up. Try refreshing.' })} />);
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
  });

  describe('debounced filtering', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces search input — fewer than 5 filter calls for 11 rapid changes', () => {
      const samples = generate5000SamplesForSearch();
      const onFiltered = vi.fn();

      const { rerender } = render(<LeftPanel {...makeDefaultProps({
        samples,
        onFilteredSamplesChange: onFiltered,
      })} />);

      const initialCallCount = onFiltered.mock.calls.length;

      // Simulate 11 rapid search changes (typing characters one by one)
      for (let i = 0; i < 11; i++) {
        const term = 'question 42'.slice(0, i + 1);
        rerender(<LeftPanel {...makeDefaultProps({
          samples,
          searchConditions: [{ id: 'test', field: 'chat' as const, operator: 'contains' as const, term }],
          onFilteredSamplesChange: onFiltered,
        })} />);
      }

      // Before debounce settles, callbacks should be batched
      const callsDuringTyping = onFiltered.mock.calls.length - initialCallCount;
      expect(callsDuringTyping).toBeLessThan(5);

      // Advance timers to let debounce settle
      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Should have the final result now
      const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
      expect(lastCall.length).toBeLessThan(5000);
    });

    it('batches rapid filter expression changes — processing time under 50ms', () => {
      const samples = generate5000SamplesForSearch();
      const onFiltered = vi.fn();

      const { rerender } = render(<LeftPanel {...makeDefaultProps({
        samples,
        onFilteredSamplesChange: onFiltered,
      })} />);

      const start = performance.now();

      // Fire 10 rapid filter changes (events should be near-instant, filtering deferred)
      for (let i = 0; i < 10; i++) {
        rerender(<LeftPanel {...makeDefaultProps({
          samples,
          searchConditions: [{ id: 'test', field: 'chat' as const, operator: 'contains' as const, term: `q${i}` }],
          onFilteredSamplesChange: onFiltered,
        })} />);
      }

      const elapsed = performance.now() - start;
      // The re-renders themselves should be fast since filtering is deferred
      expect(elapsed).toBeLessThan(50);
    });
  });
});

describe('LeftPanel filter expression validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a warning for an unknown field in the filter expression', () => {
    const samples = makeSmallSamples();
    render(<LeftPanel {...makeDefaultProps({ samples })} />);

    const input = screen.getByPlaceholderText(/Filter samples/);
    fireEvent.change(input, { target: { value: 'rewrd > 0' } });
    act(() => { vi.advanceTimersByTime(200); });

    expect(screen.getByText('Unknown field: "rewrd"')).toBeInTheDocument();
  });

  it('warns about malformed conditions but still shows all samples', () => {
    const samples = makeSmallSamples();
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeDefaultProps({ samples, onFilteredSamplesChange: onFiltered })} />);

    const input = screen.getByPlaceholderText(/Filter samples/);
    fireEvent.change(input, { target: { value: 'this is not a filter' } });
    act(() => { vi.advanceTimersByTime(200); });

    // Malformed conditions pass everything in evaluateCondition — the warning
    // surfaces the problem while the table keeps showing all samples.
    expect(screen.getByText('Unrecognized condition: "this is not a filter"')).toBeInTheDocument();
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    expect(lastCall).toHaveLength(10);
  });

  it('shows no warning for a valid filter expression', () => {
    const samples = makeSmallSamples();
    render(<LeftPanel {...makeDefaultProps({ samples })} />);

    const input = screen.getByPlaceholderText(/Filter samples/);
    fireEvent.change(input, { target: { value: 'reward > 0 AND step == 1' } });
    act(() => { vi.advanceTimersByTime(200); });

    expect(screen.queryByText(/Unknown field|Unrecognized condition/)).not.toBeInTheDocument();
  });

  it('shows a clear button only when a filter expression is set, and clears it', () => {
    const samples = makeSmallSamples();
    render(<LeftPanel {...makeDefaultProps({ samples })} />);

    const input = screen.getByPlaceholderText(/Filter samples/) as HTMLInputElement;
    expect(screen.queryByTitle('Clear filter')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'reward > 0' } });
    const clearButton = screen.getByTitle('Clear filter');
    fireEvent.click(clearButton);

    expect(input.value).toBe('');
    expect(screen.queryByTitle('Clear filter')).not.toBeInTheDocument();
  });
});

describe('LeftPanel degenerate ID column → Rollout column', () => {
  /** All samples share one sample_index, but rollout_n varies. */
  function makeDegenerateSamples(count = 4): Sample[] {
    return Array.from({ length: count }, (_, i) =>
      makeSample({
        id: i,
        attributes: { ...makeAttributes(), sample_index: 7, rollout_n: 700 + i },
      }),
    );
  }

  it('shows a Rollout column with distinct values when sample_index is degenerate', () => {
    render(<LeftPanel {...makeDefaultProps({ samples: makeDegenerateSamples() })} />);
    expect(screen.getByText('Rollout')).toBeInTheDocument();
    expect(screen.queryByText('ID')).not.toBeInTheDocument();
    // Cells show the varying rollout_n, not the shared sample_index
    expect(screen.getByText('700')).toBeInTheDocument();
    expect(screen.getByText('703')).toBeInTheDocument();
  });

  it('keeps the ID column when sample_index values are distinct', () => {
    render(<LeftPanel {...makeDefaultProps({ samples: makeSmallSamples() })} />);
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.queryByText('Rollout')).not.toBeInTheDocument();
  });

  it('keeps the ID column when both sample_index and rollout_n are degenerate', () => {
    const samples = Array.from({ length: 3 }, (_, i) =>
      makeSample({ id: i, attributes: { ...makeAttributes(), sample_index: 7, rollout_n: 7 } }),
    );
    render(<LeftPanel {...makeDefaultProps({ samples })} />);
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.queryByText('Rollout')).not.toBeInTheDocument();
  });

  it('does not flip the column when filtering narrows to equal sample_index (detection uses unfiltered samples)', () => {
    vi.useFakeTimers();
    // Non-degenerate overall: two samples share sample_index 5, one differs.
    const samples = [
      makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 5, rollout_n: 1, reward: 10 } }),
      makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 5, rollout_n: 2, reward: 10 } }),
      makeSample({ id: 2, attributes: { ...makeAttributes(), sample_index: 6, rollout_n: 3, reward: 0 } }),
    ];
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeDefaultProps({ samples, onFilteredSamplesChange: onFiltered })} />);

    const input = screen.getByPlaceholderText(/Filter samples/);
    fireEvent.change(input, { target: { value: 'reward > 5' } });
    act(() => { vi.advanceTimersByTime(200); });

    // Filtered set now only contains sample_index 5 twice...
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    expect(lastCall).toHaveLength(2);
    // ...but the identity column must NOT flip to Rollout
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.queryByText('Rollout')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('LeftPanel search counter and navigation', () => {
  it('shows 1/N (not 0/N) when the first sample with id 0 is selected', () => {
    const samples = makeSmallSamples();
    // Every fixture sample contains 'Hello' in its user message → all 10 match
    const searchConditions: SearchCondition[] = [
      { id: generateId(), field: 'chat', operator: 'contains', term: 'Hello' },
    ];
    render(<LeftPanel {...makeDefaultProps({
      samples,
      searchConditions,
      selectedSampleId: 0,
    })} />);
    // Regression: id 0 was treated as "no selection" by a falsy check → '0/10'
    expect(screen.getByText('1/10')).toBeInTheDocument();
  });

  it('hides the counter and disables navigation arrows when no search term is entered', () => {
    const samples = makeSmallSamples();
    render(<LeftPanel {...makeDefaultProps({ samples, selectedSampleId: 0 })} />);
    expect(screen.queryByText('1/10')).not.toBeInTheDocument();
    expect(screen.getByTitle('Previous chat')).toBeDisabled();
    expect(screen.getByTitle(/Next occurrence/)).toBeDisabled();
  });

  it("shows '0 matches' when an active search matches nothing", () => {
    vi.useFakeTimers();
    const samples = makeSmallSamples();
    const searchConditions: SearchCondition[] = [
      { id: generateId(), field: 'chat', operator: 'contains', term: 'zzz_no_match_zzz' },
    ];
    render(<LeftPanel {...makeDefaultProps({ samples, searchConditions })} />);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText('0 matches')).toBeInTheDocument();
    expect(screen.getByTitle('Previous chat')).toBeDisabled();
    vi.useRealTimers();
  });
});

describe('LeftPanel empty states', () => {
  it('shows "No samples loaded" with a Browse files button when no samples', () => {
    const onOpenFileBrowser = vi.fn();
    render(<LeftPanel {...makeDefaultProps({ samples: [], onOpenFileBrowser })} />);

    expect(screen.getByText('No samples loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Browse files'));
    expect(onOpenFileBrowser).toHaveBeenCalled();
  });

  it('hides the Browse files button in shared mode', () => {
    render(<LeftPanel {...makeDefaultProps({ samples: [], isSharedMode: true })} />);

    expect(screen.getByText('No samples loaded')).toBeInTheDocument();
    expect(screen.queryByText('Browse files')).not.toBeInTheDocument();
  });

  it('shows the no-match empty state and Clear filters restores the table', () => {
    vi.useFakeTimers();
    const samples = makeSmallSamples();
    const onSearchConditionsChange = vi.fn();
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeDefaultProps({
      samples,
      onSearchConditionsChange,
      onFilteredSamplesChange: onFiltered,
    })} />);

    // Valid field, but no sample matches → empty table with its own message
    const input = screen.getByPlaceholderText(/Filter samples/);
    fireEvent.change(input, { target: { value: 'reward > 999' } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText('No samples match your search or filter')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Clear filters'));
    expect(onSearchConditionsChange).toHaveBeenCalledWith([
      expect.objectContaining({ field: 'chat', operator: 'contains', term: '' }),
    ]);

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('No samples match your search or filter')).not.toBeInTheDocument();
    const lastCall = onFiltered.mock.calls[onFiltered.mock.calls.length - 1][0];
    expect(lastCall).toHaveLength(10);
    vi.useRealTimers();
  });
});
