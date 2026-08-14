/**
 * Metadata-only load banner: when bulk message hydration is skipped for huge
 * files, the user must see it (search silently missing content would be a
 * trust bug) and be able to trigger the full load.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { LeftPanel } from './index';
import { makeSample, makeAttributes } from '../../test/fixtures';

const panelProps = {
  selectedSampleId: null,
  onSelectSample: vi.fn(),
  experimentName: 'exp',
  filePaths: ['big.jsonl'],
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

const samples = [
  makeSample({ id: 0, attributes: { ...makeAttributes(), sample_index: 1, reward: 0.5 } }),
  makeSample({ id: 1, attributes: { ...makeAttributes(), sample_index: 2, reward: 0.7 } }),
];

describe('LeftPanel hydration banner', () => {
  it('shows the metadata-only banner with a Load all action when hydration was skipped', () => {
    const onLoadAllMessages = vi.fn();
    render(
      <LeftPanel
        {...panelProps}
        samples={samples}
        hydrationSkipped
        onLoadAllMessages={onLoadAllMessages}
      />,
    );
    expect(screen.getByText(/Metadata-only load/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Load all messages'));
    expect(onLoadAllMessages).toHaveBeenCalled();
  });

  it('renders no banner in the normal fully-hydrated case', () => {
    render(<LeftPanel {...panelProps} samples={samples} />);
    expect(screen.queryByText(/Metadata-only load/)).not.toBeInTheDocument();
  });
});
