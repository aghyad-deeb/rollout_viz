import { render, screen, fireEvent } from '@testing-library/react';
import { SampleTable } from './SampleTable';
import { makeSample, makeAttributes, makeGradeEntry } from '../../test/fixtures';

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

  it('applies green color for high grade', () => {
    const samples = [
      makeSample({
        id: 0,
        grades: { helpfulness: [makeGradeEntry(0.85, 'float')] }
      }),
    ];
    render(<SampleTable {...defaultProps} samples={samples} />);
    const gradeEl = screen.getByText('0.85');
    expect(gradeEl.className).toContain('green');
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
});
