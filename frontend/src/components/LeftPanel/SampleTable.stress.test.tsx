/**
 * Stress tests for SampleTable with 5,000 samples.
 *
 * Tests virtual scrolling, grade column rendering, metric extraction,
 * and render performance at scale.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { SampleTable } from './SampleTable';
import { makeSample, makeAttributes, makeGradeEntry } from '../../test/fixtures';
import type { Sample } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generate5000Samples(options?: {
  withGrades?: boolean;
  numMetrics?: number;
}): Sample[] {
  const { withGrades = false, numMetrics = 0 } = options ?? {};
  const metrics = Array.from({ length: numMetrics }, (_, i) => `metric_${i}`);

  return Array.from({ length: 5000 }, (_, i) => {
    const grades: Record<string, ReturnType<typeof makeGradeEntry>[]> = {};
    if (withGrades) {
      for (const metric of metrics) {
        // Ensure grade value matches grade_type (bool gets boolean, float gets number)
        const isBool = i % 2 === 0;
        grades[metric] = [makeGradeEntry(
          isBool ? (i % 3 === 0) : Math.round(Math.random() * 100) / 100,
          isBool ? 'bool' : 'float',
        )];
      }
    }

    return makeSample({
      id: i,
      attributes: {
        ...makeAttributes(),
        sample_index: i,
        rollout_n: i,
        step: i % 100,
        reward: Math.round((Math.random() * 2 - 1) * 100) / 100,
        data_source: `source_${i % 10}/batch_${Math.floor(i / 100)}`,
        experiment_name: `exp_${i % 3}`,
      },
      ...(withGrades ? { grades } : {}),
    });
  });
}

const defaultProps = {
  selectedSampleId: null,
  onSelectSample: vi.fn(),
  sortColumn: 'sample_index' as const,
  sortOrder: 'asc' as const,
  onSort: vi.fn(),
  isDarkMode: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SampleTable stress (5,000 samples)', () => {
  it('renders without crashing with 5,000 samples', () => {
    const samples = generate5000Samples();
    const { container } = render(<SampleTable {...defaultProps} samples={samples} />);

    // Should have a container with height for all 5,000 rows
    const innerDiv = container.querySelector('[style*="height"]');
    expect(innerDiv).toBeTruthy();
    // Total height = 5000 * 36px = 180000px
    expect(innerDiv?.getAttribute('style')).toContain('180000');
  });

  it('only renders a small window of rows (virtual scrolling)', () => {
    const samples = generate5000Samples();
    const { container } = render(<SampleTable {...defaultProps} samples={samples} />);

    // Count actual rendered row elements (each row has cursor-pointer class)
    const renderedRows = container.querySelectorAll('[class*="cursor-pointer"]');
    // Should render far fewer than 5,000 rows (typically 50-60)
    expect(renderedRows.length).toBeLessThan(100);
    expect(renderedRows.length).toBeGreaterThan(0);
  });

  it('renders within acceptable time (< 500ms) for 5,000 samples', () => {
    const samples = generate5000Samples();

    const start = performance.now();
    const { unmount } = render(<SampleTable {...defaultProps} samples={samples} />);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    unmount();
  });

  it('renders within acceptable time with 5 grade columns', () => {
    const samples = generate5000Samples({ withGrades: true, numMetrics: 5 });

    const start = performance.now();
    const { container, unmount } = render(<SampleTable {...defaultProps} samples={samples} />);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);

    // Verify grade columns appear in header
    // The metric names are truncated to 8 chars
    const headers = container.querySelectorAll('[class*="uppercase"]');
    expect(headers.length).toBeGreaterThan(0);

    unmount();
  });

  it('renders within acceptable time with 10 grade columns', () => {
    const samples = generate5000Samples({ withGrades: true, numMetrics: 10 });

    const start = performance.now();
    const { unmount } = render(<SampleTable {...defaultProps} samples={samples} />);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1500);
    unmount();
  });

  it('handles row selection with 5,000 samples', () => {
    const onSelect = vi.fn();
    const samples = generate5000Samples();

    const { container } = render(<SampleTable {...defaultProps} samples={samples} onSelectSample={onSelect} />);

    // Data rows have position: absolute style (virtual scrolling), header rows don't
    const rows = container.querySelectorAll('[style*="position: absolute"]');
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalled();
  });

  it('highlights selected sample among 5,000', () => {
    const samples = generate5000Samples();
    // Select the first sample (id=0, which should be in the visible range)
    const { container } = render(
      <SampleTable {...defaultProps} samples={samples} selectedSampleId={0} />
    );

    const selectedRow = container.querySelector('[class*="bg-blue"]');
    expect(selectedRow).toBeTruthy();
  });

  it('sort callback works with 5,000 samples', () => {
    const onSort = vi.fn();
    const samples = generate5000Samples();

    render(<SampleTable {...defaultProps} samples={samples} onSort={onSort} />);
    fireEvent.click(screen.getByText('Step'));
    expect(onSort).toHaveBeenCalledWith('step');
  });

  it('correctly extracts metric names from 5,000 graded samples', () => {
    const samples = generate5000Samples({ withGrades: true, numMetrics: 5 });

    const { container } = render(<SampleTable {...defaultProps} samples={samples} />);

    // The header should contain metric column headers
    // metric_0 through metric_4, truncated to 8 chars: "Metric_…" or "Metric_0" etc.
    const headerText = container.querySelector('[class*="uppercase"]')?.textContent || '';
    // At least one metric should appear
    expect(headerText.toLowerCase()).toContain('metric');
  });

  it('re-renders efficiently when selectedSampleId changes', () => {
    const samples = generate5000Samples();

    const { rerender } = render(
      <SampleTable {...defaultProps} samples={samples} selectedSampleId={0} />
    );

    const start = performance.now();
    rerender(<SampleTable {...defaultProps} samples={samples} selectedSampleId={100} />);
    const elapsed = performance.now() - start;

    // Re-render should be fast since virtual scrolling only touches visible rows
    expect(elapsed).toBeLessThan(200);
  });

  it('scroll handler uses requestAnimationFrame', () => {
    const samples = generate5000Samples();
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    const { container } = render(<SampleTable {...defaultProps} samples={samples} />);

    const scrollContainer = container.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      fireEvent.scroll(scrollContainer);
      expect(rafSpy).toHaveBeenCalled();
    }

    rafSpy.mockRestore();
  });

  it('handles 20 rapid scroll events under 50ms', () => {
    const samples = generate5000Samples();
    const { container } = render(<SampleTable {...defaultProps} samples={samples} />);

    const scrollContainer = container.querySelector('.overflow-y-auto');
    if (!scrollContainer) return;

    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      fireEvent.scroll(scrollContainer, { target: { scrollTop: i * 100 } });
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it('handles dark mode toggle with 5,000 samples', () => {
    const samples = generate5000Samples();

    const { rerender, container } = render(
      <SampleTable {...defaultProps} samples={samples} isDarkMode={false} />
    );

    const start = performance.now();
    rerender(<SampleTable {...defaultProps} samples={samples} isDarkMode={true} />);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
    // Should have dark mode styling
    expect(container.innerHTML).toContain('gray');
  });
});
