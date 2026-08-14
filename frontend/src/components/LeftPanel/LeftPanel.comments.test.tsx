/**
 * The dedicated Comments column sorts by HOW MANY notes a rollout has — not
 * by the text of the newest one (which is what the generic grade-column path
 * would have done, back when comments still rendered as a grade metric).
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { LeftPanel } from './index';
import { makeSample, makeAttributes } from '../../test/fixtures';
import { buildCommentTombstone } from '../../utils/humanGrades';
import type { GradeEntry, Sample } from '../../types';

const generateId = () => Math.random().toString(36).substring(2, 9);

function comment(text: string, author = 'ada', timestamp = '2026-01-15T10:00:00'): GradeEntry {
  return {
    grade: text,
    grade_type: 'freeform',
    quotes: [],
    explanation: '',
    model: `human:${author}`,
    prompt_version: 'comment-v1',
    timestamp,
  };
}

/** ids 0..2 with 0, 2 and 1 comments respectively (deliberately unordered). */
function samplesWithComments(): Sample[] {
  const counts = [0, 2, 1];
  return counts.map((n, i) =>
    makeSample({
      id: i,
      attributes: { ...makeAttributes(), sample_index: i, rollout_n: 700 + i },
      grades: n > 0
        ? { comments: Array.from({ length: n }, (_, k) => comment(`note ${i}.${k}`)) }
        : undefined,
    }),
  );
}

function makeProps(overrides: Partial<Parameters<typeof LeftPanel>[0]> = {}) {
  return {
    samples: [] as Sample[],
    selectedSampleId: null,
    onSelectSample: vi.fn(),
    experimentName: 'comments_test',
    filePaths: ['comments_test.jsonl'],
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

describe('LeftPanel comments column', () => {
  it('sorts ascending then descending by comment count', () => {
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: samplesWithComments(), onFilteredSamplesChange: onFiltered })} />);
    expect(orderOf(onFiltered)).toEqual([0, 1, 2]);

    const header = screen.getByTitle('Comments');
    fireEvent.click(header);
    // counts 0, 1, 2 → ids 0, 2, 1
    expect(orderOf(onFiltered)).toEqual([0, 2, 1]);

    fireEvent.click(header);
    expect(orderOf(onFiltered)).toEqual([1, 2, 0]);
  });

  it('does not offer the column when nothing has been commented on', () => {
    render(<LeftPanel {...makeProps({ samples: [makeSample({ id: 0 })] })} />);
    expect(screen.queryByTitle('Comments')).not.toBeInTheDocument();
  });

  // Deletion is append-only: a tombstone joins the same list. The count the
  // column sorts on must be of the SURVIVORS, not of the raw rows.
  it('sorts on visible comments, ignoring deleted ones and their tombstones', () => {
    const onFiltered = vi.fn();
    const gone0 = comment('gone', 'ada', 'ts-0');
    const gone2 = comment('gone', 'ada', 'ts-2');
    const samples = [
      // 1 visible (2 raw comments + 1 tombstone)
      makeSample({
        id: 0,
        attributes: { ...makeAttributes(), sample_index: 0, rollout_n: 700 },
        grades: { comments: [gone0, comment('kept', 'grace', 'ts-1'), buildCommentTombstone(gone0, 'grace')] },
      }),
      // 3 visible
      makeSample({
        id: 1,
        attributes: { ...makeAttributes(), sample_index: 1, rollout_n: 701 },
        grades: {
          comments: [comment('a', 'ada', 'ts-3'), comment('b', 'ada', 'ts-4'), comment('c', 'ada', 'ts-5')],
        },
      }),
      // 0 visible (its only comment was deleted)
      makeSample({
        id: 2,
        attributes: { ...makeAttributes(), sample_index: 2, rollout_n: 702 },
        grades: { comments: [gone2, buildCommentTombstone(gone2, 'ada')] },
      }),
    ];
    render(<LeftPanel {...makeProps({ samples, onFilteredSamplesChange: onFiltered })} />);

    const header = screen.getByTitle('Comments');
    fireEvent.click(header);
    // counts 1, 3, 0 → ascending ids 2, 0, 1
    expect(orderOf(onFiltered)).toEqual([2, 0, 1]);

    fireEvent.click(header);
    expect(orderOf(onFiltered)).toEqual([1, 0, 2]);
  });
});

// The filter mini-language exposes each metric's LATEST grade as a queryable
// field. For `comments` that must be the latest VISIBLE comment: a tombstone's
// empty grade must never become the queried value.
describe('LeftPanel comments filter field', () => {
  const applyFilter = (expression: string) => {
    const input = screen.getByPlaceholderText(/Filter samples/);
    fireEvent.change(input, { target: { value: expression } });
    act(() => { vi.advanceTimersByTime(200); });
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * id 0: newest comment deleted, an older one survives.
   * id 1: its only comment deleted — must behave as if `comments` is absent.
   * id 2: an ordinary undeleted comment.
   */
  function samples(): Sample[] {
    const newest = comment('deleted newest', 'grace', 'ts-1');
    const onlyOne = comment('deleted only', 'ada', 'ts-2');
    return [
      makeSample({
        id: 0,
        attributes: { ...makeAttributes(), sample_index: 0 },
        grades: { comments: [comment('surviving older', 'ada', 'ts-0'), newest, buildCommentTombstone(newest, 'ada')] },
      }),
      makeSample({
        id: 1,
        attributes: { ...makeAttributes(), sample_index: 1 },
        grades: { comments: [onlyOne, buildCommentTombstone(onlyOne, 'ada')] },
      }),
      makeSample({
        id: 2,
        attributes: { ...makeAttributes(), sample_index: 2 },
        grades: { comments: [comment('plain note', 'grace', 'ts-3')] },
      }),
    ];
  }

  it('queries the latest VISIBLE comment, not the deleted one', () => {
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: samples(), onFilteredSamplesChange: onFiltered })} />);

    applyFilter('comments contains surviving');
    expect(orderOf(onFiltered)).toEqual([0]);

    applyFilter('comments contains deleted');
    expect(orderOf(onFiltered)).toEqual([]);
  });

  it('treats a fully-deleted thread as an absent metric', () => {
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: samples(), onFilteredSamplesChange: onFiltered })} />);

    // Every sample with any visible comment matches the empty substring; the
    // one whose comments were all deleted has no `comments` field at all.
    applyFilter('comments contains e');
    expect(orderOf(onFiltered)).toEqual([0, 2]);
  });

  it('never surfaces the tombstone\'s empty grade as the comment text', () => {
    const onFiltered = vi.fn();
    render(<LeftPanel {...makeProps({ samples: samples(), onFilteredSamplesChange: onFiltered })} />);

    // id 0's newest RAW entry is a tombstone (grade ''); an exact match on the
    // surviving text only succeeds if the tombstone was skipped.
    applyFilter('comments == surviving older');
    expect(orderOf(onFiltered)).toEqual([0]);
  });
});
