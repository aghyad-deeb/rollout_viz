import { render, screen, fireEvent, within } from '@testing-library/react';
import { SampleTable } from './SampleTable';
import { makeSample, makeAttributes, makeGradeEntry } from '../../test/fixtures';
import { buildCommentTombstone } from '../../utils/humanGrades';

describe('SampleTable', () => {
  const defaultProps = {
    selectedSampleId: null,
    onSelectSample: vi.fn(),
    sortColumn: 'sample_index' as const,
    sortOrder: 'asc' as const,
    onSort: vi.fn(),
    isDarkMode: false,
  };

  it('renders sample rows', () => {
    const samples = [
      makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 10, reward: 1.5 } }),
      makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 11, reward: -0.5 } }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    // Check that sample_index values appear (using unique IDs to avoid collisions with step column)
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
  });

  it('places the Source column right after Reward, before the grade columns', () => {
    const samples = [
      makeSample({ id: 0, grades: { accuracy: [makeGradeEntry(true, 'bool')] } }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    // Header order: ID, Step, Reward, Source, then metric columns.
    const headers = [
      screen.getByTitle('Sample ID'),
      screen.getByTitle('Step'),
      screen.getByTitle('Reward'),
      screen.getByTitle('Data Source'),
      screen.getByTitle('Accuracy'),
    ];
    for (let i = 0; i < headers.length - 1; i++) {
      // eslint-disable-next-line no-bitwise
      expect(headers[i].compareDocumentPosition(headers[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('displays grade checkmark for bool true', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { accuracy: [makeGradeEntry(true, 'bool')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('displays grade X for bool false', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { accuracy: [makeGradeEntry(false, 'bool')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    expect(screen.getByText('✗')).toBeInTheDocument();
  });

  it('displays formatted float grade', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { helpfulness: [makeGradeEntry(0.75, 'float')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    expect(screen.getByText('0.75')).toBeInTheDocument();
  });

  it('applies teal color for high grade', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { helpfulness: [makeGradeEntry(0.85, 'float')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    const gradeEl = screen.getByText('0.85');
    // Positive grades use the app's teal identity (matches Analysis view)
    expect(gradeEl.className).toContain('text-teal-700');
  });

  it('applies red color for low grade', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { helpfulness: [makeGradeEntry(0.2, 'float')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    const gradeEl = screen.getByText('0.20');
    expect(gradeEl.className).toContain('red');
  });

  it('calls onSelectSample when row clicked', () => {
    const onSelect = vi.fn();
    const samples = [makeSample({ id: 42, attributes: { ...makeAttributes(), sample_index: 99, step: 5 } })];
    render(<SampleTable {...defaultProps} samples={samples} onSelectSample={onSelect} />);
    // Find the row via the unique sample_index value
    const row = screen.getByText('99').closest('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(42);
  });

  it('highlights selected sample', () => {
    const samples = [makeSample({ id: 5, attributes: { ...makeAttributes(), sample_index: 77, step: 3 } })];
    render(<SampleTable {...defaultProps} samples={samples} selectedSampleId={5} />);
    // The selected row should have a highlight class
    const row = screen.getByText('77').closest('[class*="cursor-pointer"]');
    expect(row?.className).toContain('bg-blue');
  });

  it('calls onSort when header clicked', () => {
    const onSort = vi.fn();
    const samples = [makeSample({ id: 0 })];
    render(<SampleTable {...defaultProps} samples={samples} onSort={onSort} />);
    // Click the "Step" header
    fireEvent.click(screen.getByText('Step'));
    expect(onSort).toHaveBeenCalledWith('step');
  });

  it('shows sort indicator on active column', () => {
    const samples = [makeSample({ id: 0 })];
    render(<SampleTable {...defaultProps} samples={samples} sortColumn="reward" sortOrder="desc" />);
    expect(screen.getByText('↓')).toBeInTheDocument();
  });

  it('sets container height based on sample count', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      makeSample({ id: i, attributes: { ...makeAttributes(), sample_index: i } })
    );
    const { container } = render(<SampleTable {...defaultProps} samples={samples} />);
    // Total height should be samples * ROW_HEIGHT (36px)
    const innerDiv = container.querySelector('[style*="height"]');
    expect(innerDiv?.getAttribute('style')).toContain('360');
  });

  it('renders without crashing when messages are empty (metadata-only)', () => {
    // When messages are empty (metadata-only phase), the table should still render
    const samples = [
      makeSample({ id: 0, messages: [], message_count: 5, attributes: { ...makeAttributes(), sample_index: 50 } }),
      makeSample({ id: 1, messages: [], message_count: 3, attributes: { ...makeAttributes(), sample_index: 51 } }),
    ];

    render(<SampleTable {...defaultProps} samples={samples} />);
    // Should render the sample rows
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('51')).toBeInTheDocument();
  });

  it('renders dash for ungraded metric', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { helpfulness: [makeGradeEntry(0.5, 'float')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    // The metric column should show the grade for helpfulness
    // and potentially a dash for other metrics
    expect(screen.getByText('0.50')).toBeInTheDocument();
  });

  it('renders int grades in a neutral color (not the float gradient)', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { violation_count: [makeGradeEntry(5, 'int')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    const gradeEl = screen.getByText('5');
    expect(gradeEl.className).toContain('text-gray-700');
    expect(gradeEl.className).not.toContain('green');
    expect(gradeEl.className).not.toContain('red');
  });

  it('does not render a favourite star column', () => {
    const samples = [makeSample({ id: 0 })];
    render(<SampleTable {...defaultProps} samples={samples} />);
    expect(screen.queryByText('★')).not.toBeInTheDocument();
    expect(screen.queryByText('☆')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Add to favourites')).not.toBeInTheDocument();
  });

  describe('comments column', () => {
    // Comments are freeform human entries on the reserved `comments` metric.
    const commentEntry = (text: string, author: string, timestamp = '2026-01-15T10:00:00') => ({
      grade: text,
      grade_type: 'freeform' as const,
      quotes: [],
      explanation: '',
      model: `human:${author}`,
      prompt_version: 'comment-v1',
      timestamp,
    });

    // Cell tooltips start with the count ("2 comments · latest — …"); the
    // header's is the bare word.
    const commentCell = () => screen.getByTitle(/^\d+ comment/);

    it('is absent when no loaded sample has comments', () => {
      const samples = [makeSample({ id: 0, grades: { accuracy: [makeGradeEntry(true, 'bool')] } })];
      render(<SampleTable {...defaultProps} samples={samples} />);
      expect(screen.queryByTitle('Comments')).not.toBeInTheDocument();
    });

    it('renders a compact count once any sample has a comment', () => {
      const samples = [
        makeSample({
          id: 0,
          grades: { comments: [commentEntry('first', 'ada'), commentEntry('second', 'grace')] },
        }),
        makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 1 } }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      expect(screen.getByTitle('Comments')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('never renders comments as a grade column', () => {
      const samples = [makeSample({ id: 0, grades: { comments: [commentEntry('note', 'ada')] } })];
      render(<SampleTable {...defaultProps} samples={samples} />);
      // The generic grade column would have been titled with the capitalized
      // metric name and shown truncated prose in the cell.
      expect(screen.queryByTitle('Comments: note')).not.toBeInTheDocument();
      expect(screen.queryByText('note')).not.toBeInTheDocument();
    });

    it('names the latest comment in the cell tooltip', () => {
      const samples = [
        makeSample({
          id: 0,
          grades: {
            comments: [
              commentEntry('older thought', 'ada', '2026-01-15T10:00:00'),
              commentEntry('this looks like a reward hack', 'grace', '2026-01-15T11:00:00'),
            ],
          },
        }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      expect(commentCell().getAttribute('title'))
        .toBe('2 comments · latest — grace: this looks like a reward hack');
    });

    it('keeps placeholder and value in the same centered box', () => {
      const samples = [
        makeSample({ id: 0, grades: { comments: [commentEntry('note', 'ada')] } }),
        makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 1 } }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      const withComment = screen.getByTitle(/^1 comment/);
      const without = screen.getByTitle('No comments');
      expect(withComment.style.width).toBe(without.style.width);
      expect(withComment.className).toContain('justify-center');
      expect(without.className).toContain('justify-center');
    });

    it('sorts on comment count, not on the comment text', () => {
      const onSort = vi.fn();
      const samples = [makeSample({ id: 0, grades: { comments: [commentEntry('note', 'ada')] } })];
      render(<SampleTable {...defaultProps} samples={samples} onSort={onSort} />);
      fireEvent.click(screen.getByTitle('Comments'));
      expect(onSort).toHaveBeenCalledWith('comment_count');
    });

    it('shows the sort indicator when the table is sorted by comments', () => {
      const samples = [makeSample({ id: 0, grades: { comments: [commentEntry('note', 'ada')] } })];
      render(
        <SampleTable {...defaultProps} samples={samples} sortColumn="comment_count" sortOrder="desc" />,
      );
      expect(within(screen.getByTitle('Comments')).getByText('↓')).toBeInTheDocument();
    });

    // Deletions are append-only tombstones in the same list — the column must
    // read through visibleComments, never the raw entries.
    describe('soft-deleted comments', () => {
      it('counts only the survivors', () => {
        const doomed = commentEntry('retracted', 'ada', '2026-01-15T10:00:00');
        const samples = [
          makeSample({
            id: 0,
            grades: {
              comments: [
                doomed,
                commentEntry('kept', 'grace', '2026-01-15T11:00:00'),
                buildCommentTombstone(doomed, 'grace'),
              ],
            },
          }),
        ];
        render(<SampleTable {...defaultProps} samples={samples} />);
        expect(commentCell().getAttribute('title')).toMatch(/^1 comment ·/);
        expect(screen.getByText('1')).toBeInTheDocument();
      });

      it('names the latest VISIBLE comment in the tooltip', () => {
        // The newest raw entry is the tombstone; the newest real one is ada's.
        const doomed = commentEntry('deleted last word', 'grace', '2026-01-15T11:00:00');
        const samples = [
          makeSample({
            id: 0,
            grades: {
              comments: [
                commentEntry('the real latest', 'ada', '2026-01-15T10:00:00'),
                doomed,
                buildCommentTombstone(doomed, 'ada'),
              ],
            },
          }),
        ];
        render(<SampleTable {...defaultProps} samples={samples} />);
        expect(commentCell().getAttribute('title'))
          .toBe('1 comment · latest — ada: the real latest');
      });

      it('falls back to the em-dash placeholder when every comment is deleted', () => {
        const doomed = commentEntry('gone', 'ada', '2026-01-15T10:00:00');
        const samples = [
          makeSample({ id: 0, grades: { comments: [doomed, buildCommentTombstone(doomed, 'ada')] } }),
          makeSample({
            id: 1,
            attributes: { ...makeAttributes(), sample_index: 1 },
            grades: { comments: [commentEntry('still here', 'grace', '2026-01-15T12:00:00')] },
          }),
        ];
        render(<SampleTable {...defaultProps} samples={samples} />);
        expect(screen.getByTitle('No comments')).toBeInTheDocument();
        expect(screen.getByTitle(/^1 comment/)).toBeInTheDocument();
      });

      it('drops the whole column when every comment in the corpus is deleted', () => {
        const doomed = commentEntry('gone', 'ada', '2026-01-15T10:00:00');
        const samples = [
          makeSample({ id: 0, grades: { comments: [doomed, buildCommentTombstone(doomed, 'ada')] } }),
        ];
        render(<SampleTable {...defaultProps} samples={samples} />);
        expect(screen.queryByTitle('Comments')).not.toBeInTheDocument();
      });
    });
  });

  describe('sticky header / single scroller', () => {
    it('renders the header inside the scroll container with sticky positioning', () => {
      const samples = [makeSample({ id: 0 })];
      const { container } = render(<SampleTable {...defaultProps} samples={samples} />);
      const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
      const header = scroller.querySelector('.sticky') as HTMLElement;
      expect(header).toBeTruthy();
      expect(header.className).toContain('top-0');
      // Opaque background so rows do not show through when scrolled under it
      expect(header.className).toContain('bg-gray-100');
    });

    it('applies the same min-width to the header row and the rows wrapper', () => {
      const samples = [
        makeSample({ id: 0, grades: { helpfulness: [makeGradeEntry(0.5, 'float')] } }),
      ];
      const { container } = render(<SampleTable {...defaultProps} samples={samples} />);
      const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
      const header = scroller.querySelector('.sticky') as HTMLElement;
      const rowsWrapper = scroller.querySelector('[style*="height"]') as HTMLElement;
      expect(header.style.minWidth).not.toBe('');
      expect(rowsWrapper.style.minWidth).toBe(header.style.minWidth);
    });
  });

  describe('grade column widths', () => {
    it('truncates long metric labels to 14 chars', () => {
      const samples = [
        makeSample({ id: 0, grades: { reward_hacking_detected: [makeGradeEntry(true, 'bool')] } }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      // 'Reward_hacking_detected' (23 chars) → 13 chars + ellipsis
      expect(screen.getByText('Reward_hackin…')).toBeInTheDocument();
      // Full label still available as the header tooltip
      expect(screen.getByTitle('Reward_hacking_detected')).toBeInTheDocument();
    });

    it('does not truncate metric labels of 14 chars or fewer', () => {
      const samples = [
        makeSample({ id: 0, grades: { helpfulness: [makeGradeEntry(0.5, 'float')] } }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      expect(screen.getByText('Helpfulness')).toBeInTheDocument();
    });

    it('scales metric column width with label length, capped at 130px', () => {
      const samples = [
        makeSample({
          id: 0,
          grades: {
            acc: [makeGradeEntry(true, 'bool')],
            reward_hacking_detected: [makeGradeEntry(true, 'bool')],
          },
        }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      // Short label ('Acc' = 3 chars → round(3*8.5)+12 = 38px) clamps up to the 64px floor
      const shortHeader = screen.getByTitle('Acc');
      expect(shortHeader.style.width).toBe('64px');
      // Long label (23 chars → round(23*8.5)+12 = 208px) clamps down to the 130px cap
      const longHeader = screen.getByTitle('Reward_hacking_detected');
      expect(longHeader.style.width).toBe('130px');
    });

    it('gives the Reward column a 76px width in both header and row cells', () => {
      const samples = [
        makeSample({ id: 0, attributes: { ...makeAttributes(), reward: 1.5 } }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      const header = screen.getByTitle('Reward');
      expect(header.style.width).toBe('76px');
      // The hardcoded row cell must stay in sync with the column definition
      const cell = screen.getByText('1.5');
      expect(cell.style.width).toBe('76px');
    });

    it('truncates grade value text so long previews do not overflow the cell', () => {
      const samples = [
        makeSample({
          id: 0,
          grades: {
            verdict: [{
              ...makeGradeEntry(true, 'bool'),
              grade: 'a fairly long freeform answer',
              grade_type: 'freeform',
            }],
          },
        }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      const gradeEl = screen.getByText(/a fairly long/);
      expect(gradeEl.className).toContain('truncate');
    });
  });

  describe('identity column (idColumnKey)', () => {
    it('defaults to the ID (sample_index) column', () => {
      const samples = [makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 12, rollout_n: 900 } })];
      render(<SampleTable {...defaultProps} samples={samples} />);
      expect(screen.getByText('ID')).toBeInTheDocument();
      expect(screen.queryByText('Rollout')).not.toBeInTheDocument();
      expect(screen.getByText('12')).toBeInTheDocument();
      expect(screen.queryByText('900')).not.toBeInTheDocument();
    });

    it('renders a Rollout column showing rollout_n when idColumnKey is rollout_n', () => {
      const samples = [
        makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 7, rollout_n: 700 } }),
        makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 7, rollout_n: 701 } }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} idColumnKey="rollout_n" />);
      expect(screen.getByText('Rollout')).toBeInTheDocument();
      expect(screen.getByTitle('Rollout #')).toBeInTheDocument();
      expect(screen.queryByText('ID')).not.toBeInTheDocument();
      // Cells show the distinct rollout_n values, not the degenerate sample_index
      expect(screen.getByText('700')).toBeInTheDocument();
      expect(screen.getByText('701')).toBeInTheDocument();
    });

    it('sorts by rollout_n when the Rollout header is clicked', () => {
      const onSort = vi.fn();
      const samples = [makeSample({ id: 0, attributes: { ...makeAttributes(), rollout_n: 700 } })];
      render(<SampleTable {...defaultProps} samples={samples} idColumnKey="rollout_n" onSort={onSort} />);
      fireEvent.click(screen.getByText('Rollout'));
      expect(onSort).toHaveBeenCalledWith('rollout_n');
    });
  });

  describe('source cell tooltip', () => {
    it('exposes the full data_source as a title on the truncated Source cell', () => {
      const samples = [
        makeSample({
          id: 0,
          attributes: { ...makeAttributes(), data_source: 'very/long/nested/path/source_x' },
        }),
      ];
      render(<SampleTable {...defaultProps} samples={samples} />);
      // Cell text is truncated to the last two path segments...
      const cell = screen.getByText('path/source_x');
      // ...but the tooltip carries the full path
      expect(cell).toHaveAttribute('title', 'very/long/nested/path/source_x');
    });
  });

  describe('scroll selected row into view', () => {
    const ROW_HEIGHT = 36;

    const makeSamples = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeSample({ id: i, attributes: { ...makeAttributes(), sample_index: i } })
      );

    const mockClientHeight = (el: Element, height: number) => {
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
    };

    it('scrolls an out-of-view selected row into view (centered)', () => {
      const samples = makeSamples(100);
      const { container, rerender } = render(<SampleTable {...defaultProps} samples={samples} />);
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      mockClientHeight(scroller, 360); // 10 visible rows

      rerender(<SampleTable {...defaultProps} samples={samples} selectedSampleId={50} />);
      // rowTop = 50 * 36 = 1800 → centered: 1800 - 360/2 + 36/2 = 1638
      expect(scroller.scrollTop).toBe(50 * ROW_HEIGHT - 360 / 2 + ROW_HEIGHT / 2);
    });

    it('does not scroll when the selected row is already in view', () => {
      const samples = makeSamples(100);
      const { container, rerender } = render(<SampleTable {...defaultProps} samples={samples} />);
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      mockClientHeight(scroller, 360);

      rerender(<SampleTable {...defaultProps} samples={samples} selectedSampleId={3} />);
      // Row 3 (top 108, bottom 144) is inside the 0-360 viewport — no scroll
      expect(scroller.scrollTop).toBe(0);
    });

    it('does not scroll when the container has zero height (jsdom default)', () => {
      const samples = makeSamples(100);
      const { container, rerender } = render(<SampleTable {...defaultProps} samples={samples} />);
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;

      rerender(<SampleTable {...defaultProps} samples={samples} selectedSampleId={50} />);
      expect(scroller.scrollTop).toBe(0);
    });
  });

  describe('arrow-key navigation', () => {
    const threeSamples = () => [
      makeSample({ id: 7, attributes: { ...makeAttributes(), sample_index: 1 } }),
      makeSample({ id: 8, attributes: { ...makeAttributes(), sample_index: 2 } }),
      makeSample({ id: 9, attributes: { ...makeAttributes(), sample_index: 3 } }),
    ];

    it('is focusable without a visible outline', () => {
      const { container } = render(<SampleTable {...defaultProps} samples={threeSamples()} />);
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      expect(scroller.getAttribute('tabindex')).toBe('0');
      expect(scroller.className).toContain('focus:outline-none');
    });

    it('selects the next sample on ArrowDown', () => {
      const onSelect = vi.fn();
      const { container } = render(
        <SampleTable {...defaultProps} samples={threeSamples()} selectedSampleId={8} onSelectSample={onSelect} />
      );
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      fireEvent.keyDown(scroller, { key: 'ArrowDown' });
      expect(onSelect).toHaveBeenCalledWith(9);
    });

    it('selects the previous sample on ArrowUp', () => {
      const onSelect = vi.fn();
      const { container } = render(
        <SampleTable {...defaultProps} samples={threeSamples()} selectedSampleId={8} onSelectSample={onSelect} />
      );
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      fireEvent.keyDown(scroller, { key: 'ArrowUp' });
      expect(onSelect).toHaveBeenCalledWith(7);
    });

    it('does not move past the last sample on ArrowDown', () => {
      const onSelect = vi.fn();
      const { container } = render(
        <SampleTable {...defaultProps} samples={threeSamples()} selectedSampleId={9} onSelectSample={onSelect} />
      );
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      fireEvent.keyDown(scroller, { key: 'ArrowDown' });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('selects the first sample on ArrowDown when nothing is selected', () => {
      const onSelect = vi.fn();
      const { container } = render(
        <SampleTable {...defaultProps} samples={threeSamples()} onSelectSample={onSelect} />
      );
      const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      fireEvent.keyDown(scroller, { key: 'ArrowDown' });
      expect(onSelect).toHaveBeenCalledWith(7);
    });
  });
});
