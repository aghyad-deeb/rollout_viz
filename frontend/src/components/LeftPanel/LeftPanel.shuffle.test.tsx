/**
 * Session-only random ordering of the sample table.
 *
 * Guards the invariant that matters for deep links: shuffling only changes the
 * DISPLAY order of `filteredSamples`; it never changes the id set, so anything
 * that resolves a sample by id / rollout_n / step (deep links, share tokens)
 * still works.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { LeftPanel } from './index';
import { makeSample, makeAttributes } from '../../test/fixtures';
import type { Sample } from '../../types';

const generateId = () => Math.random().toString(36).substring(2, 9);

function tenSamples(): Sample[] {
  return Array.from({ length: 10 }, (_, i) =>
    makeSample({
      id: i,
      attributes: { ...makeAttributes(), sample_index: i, rollout_n: 700 + i, data_source: `env/source_${i}` },
    }),
  );
}

function makeProps(overrides: Partial<Parameters<typeof LeftPanel>[0]> = {}) {
  return {
    samples: [] as Sample[],
    selectedSampleId: null,
    onSelectSample: vi.fn(),
    experimentName: 'shuffle_test',
    filePaths: ['shuffle_test.jsonl'],
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

const orderOf = (onFiltered: ReturnType<typeof vi.fn>): number[] => {
  const last = onFiltered.mock.calls.at(-1);
  return (last?.[0] as Sample[]).map(s => s.id);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LeftPanel session-only shuffle', () => {
  it('renders in natural (sample_index) order before shuffling', () => {
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: tenSamples(), onFilteredSamplesChange: onFiltered })} />);
    expect(orderOf(onFiltered)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(screen.getByText('Shuffle')).toBeInTheDocument();
  });

  it('shuffles into a different order on click and marks the control active', () => {
    // Deterministic RNG so the permutation is predictable: random()=0 makes
    // Fisher–Yates rotate [0..9] → [1,2,3,4,5,6,7,8,9,0].
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: tenSamples(), onFilteredSamplesChange: onFiltered })} />);

    expect(orderOf(onFiltered)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    act(() => { fireEvent.click(screen.getByRole('button', { name: /shuffle/i })); });

    const shuffled = orderOf(onFiltered);
    expect(shuffled).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // actually reordered
    expect([...shuffled].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // same id set
    expect(screen.getByText('Shuffled')).toBeInTheDocument();
  });

  it('preserves the exact id set (deep-link safety)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: tenSamples(), onFilteredSamplesChange: onFiltered })} />);
    const before = new Set(orderOf(onFiltered));
    act(() => { fireEvent.click(screen.getByRole('button', { name: /shuffle/i })); });
    const after = orderOf(onFiltered);
    expect(after).toHaveLength(10);
    expect(new Set(after)).toEqual(before); // no sample dropped, duplicated, or invented
  });

  it('restores natural order when a column header is chosen', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: tenSamples(), onFilteredSamplesChange: onFiltered })} />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: /shuffle/i })); });
    expect(orderOf(onFiltered)).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Clicking the sortable "ID" (sample_index) column header exits random order.
    act(() => { fireEvent.click(screen.getByText('ID')); });
    expect(orderOf(onFiltered)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(screen.getByText('Shuffle')).toBeInTheDocument();
  });
});
