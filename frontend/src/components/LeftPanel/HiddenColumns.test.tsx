/**
 * Constant-at-default column hiding.
 *
 * Producers historically faked reward/step/data_source just to satisfy the
 * viewer. Files where a column is constant AND equal to the schema default
 * carry no information in it — the table hides those columns behind a
 * VISIBLE "N columns hidden" pill (never silently), computed over the FULL
 * sample list so filtering can't flip visibility mid-search.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { SampleTable } from './SampleTable';
import { LeftPanel } from './index';
import { makeSample, makeAttributes } from '../../test/fixtures';

const tableProps = {
  selectedSampleId: null,
  onSelectSample: vi.fn(),
  sortColumn: 'sample_index' as const,
  sortOrder: 'asc' as const,
  onSort: vi.fn(),
  isDarkMode: false,
};

describe('SampleTable hiddenColumns prop', () => {
  const samples = [
    makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 1, reward: 0, step: 1 } }),
    makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 2, reward: 0, step: 1 } }),
  ];

  it('renders all base columns when nothing is hidden', () => {
    render(<SampleTable {...tableProps} samples={samples} />);
    expect(screen.getByText('Reward')).toBeInTheDocument();
    expect(screen.getByText('Step')).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
  });

  it('omits header and cells for hidden columns', () => {
    render(
      <SampleTable
        {...tableProps}
        samples={samples}
        hiddenColumns={new Set(['reward', 'step', 'data_source'])}
      />,
    );
    expect(screen.queryByText('Reward')).not.toBeInTheDocument();
    expect(screen.queryByText('Step')).not.toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    // Identity column survives regardless
    expect(screen.getByText('ID')).toBeInTheDocument();
  });

  it('never hides the identity or metric columns', () => {
    render(
      <SampleTable
        {...tableProps}
        samples={samples}
        hiddenColumns={new Set(['sample_index'])}
      />,
    );
    expect(screen.getByText('ID')).toBeInTheDocument();
  });
});

describe('LeftPanel default-column hiding', () => {
  const panelProps = {
    selectedSampleId: null,
    onSelectSample: vi.fn(),
    experimentName: 'exp',
    filePaths: ['test.jsonl'],
    onFilePathsChange: vi.fn(),
    onOpenFileBrowser: vi.fn(),
    searchConditions: [{ id: 'c1', field: 'chat' as const, operator: 'contains' as const, term: '' }],
    onSearchConditionsChange: vi.fn(),
    searchLogic: 'AND' as const,
    onSearchLogicChange: vi.fn(),
    loading: false,
    error: null,
    isDarkMode: false,
    onToggleDarkMode: vi.fn(),
  };

  const constantDefaults = [
    makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 1, rollout_n: 1, reward: 0, step: 1, data_source: 'unknown' } }),
    makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 2, rollout_n: 2, reward: 0, step: 1, data_source: 'unknown' } }),
  ];

  it('hides constant-at-default columns and shows the pill', () => {
    render(<LeftPanel {...panelProps} samples={constantDefaults} />);
    expect(screen.queryByTitle('Reward')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Step')).not.toBeInTheDocument();
    expect(screen.getByText(/3 columns hidden/)).toBeInTheDocument();
  });

  it('pill toggle reveals the hidden columns', () => {
    render(<LeftPanel {...panelProps} samples={constantDefaults} />);
    fireEvent.click(screen.getByText(/3 columns hidden/));
    expect(screen.getByTitle('Reward')).toBeInTheDocument();
    expect(screen.getByTitle('Step')).toBeInTheDocument();
    expect(screen.getByTitle('Data Source')).toBeInTheDocument();
  });

  it('does NOT hide columns that vary', () => {
    const varying = [
      makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 1, reward: 0.5, step: 1, data_source: 'unknown' } }),
      makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 2, reward: 0.9, step: 2, data_source: 'unknown' } }),
    ];
    render(<LeftPanel {...panelProps} samples={varying} />);
    expect(screen.getByTitle('Reward')).toBeInTheDocument();
    expect(screen.getByTitle('Step')).toBeInTheDocument();
    // data_source still constant-at-default → 1 hidden
    expect(screen.getByText(/1 column hidden/)).toBeInTheDocument();
  });

  it('does NOT hide a constant column whose value is not the default', () => {
    const constantButReal = [
      makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 1, reward: 1.0, step: 7, data_source: 'math/train' } }),
      makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 2, reward: 1.0, step: 7, data_source: 'math/train' } }),
    ];
    render(<LeftPanel {...panelProps} samples={constantButReal} />);
    expect(screen.getByTitle('Reward')).toBeInTheDocument();
    expect(screen.getByTitle('Step')).toBeInTheDocument();
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
  });

  it('treats step constant at 0 as default too', () => {
    const stepZero = [
      makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 1, reward: 0.4, step: 0, data_source: 'x' } }),
      makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 2, reward: 0.6, step: 0, data_source: 'x' } }),
    ];
    render(<LeftPanel {...panelProps} samples={stepZero} />);
    expect(screen.queryByTitle('Step')).not.toBeInTheDocument();
    expect(screen.getByText(/1 column hidden/)).toBeInTheDocument();
  });
});
