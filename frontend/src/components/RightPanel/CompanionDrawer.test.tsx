import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CompanionDrawer } from './CompanionDrawer';

const COMPANIONS = {
  companions: [
    { path: 's3://rewardseeker/logs_jsonl/auto_eval/ae_x/plan.md', name: 'plan.md', size: 2048, kind: 'markdown' },
    { path: 's3://rewardseeker/logs_jsonl/auto_eval/ae_x/runs/run_01/summary.json', name: 'runs/run_01/summary.json', size: 512, kind: 'json' },
    { path: 's3://rewardseeker/logs_jsonl/auto_eval/ae_x/runs/run_01/execution.jsonl', name: 'runs/run_01/execution.jsonl', size: 9000, kind: 'jsonl' },
  ],
};

function mockFetch(rawBody = '# The plan\n\nDo the thing.', truncated = false) {
  const fn = vi.fn((url: string) => {
    if (String(url).startsWith('/api/raw')) {
      return Promise.resolve({
        ok: true,
        headers: { get: (h: string) => (h === 'X-Truncated' && truncated ? 'true' : null) },
        text: () => Promise.resolve(rawBody),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(COMPANIONS) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const props = {
  filePath: 's3://rewardseeker/logs_jsonl/auto_eval/ae_x/runs/run_01/target.jsonl',
  isDarkMode: false,
  onClose: vi.fn(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('CompanionDrawer', () => {
  it('lists companions with sizes', async () => {
    mockFetch();
    render(<CompanionDrawer {...props} />);
    expect(await screen.findByText('plan.md')).toBeInTheDocument();
    expect(screen.getByText('runs/run_01/summary.json')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
  });

  it('opens a markdown companion and renders it', async () => {
    mockFetch('# The plan\n\nDo the thing.');
    const { container } = render(<CompanionDrawer {...props} />);
    fireEvent.click(await screen.findByText('plan.md'));
    await waitFor(() => expect(container.textContent).toContain('Do the thing.'));
  });

  it('pretty-prints json companions', async () => {
    mockFetch('{"score":1}');
    render(<CompanionDrawer {...props} />);
    fireEvent.click(await screen.findByText('runs/run_01/summary.json'));
    await waitFor(() => expect(screen.getByText(/"score": 1/)).toBeInTheDocument());
  });

  it('jsonl companions link out to a new viewer tab instead of rendering inline', async () => {
    mockFetch();
    render(<CompanionDrawer {...props} />);
    const link = (await screen.findByText('runs/run_01/execution.jsonl')).closest('a');
    expect(link).toHaveAttribute(
      'href',
      `/?file=${encodeURIComponent('s3://rewardseeker/logs_jsonl/auto_eval/ae_x/runs/run_01/execution.jsonl')}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows the truncation notice from X-Truncated', async () => {
    mockFetch('big file', true);
    render(<CompanionDrawer {...props} />);
    fireEvent.click(await screen.findByText('plan.md'));
    await waitFor(() => expect(screen.getByText(/truncated to the first 2MB/)).toBeInTheDocument());
  });

  it('shows an empty state when there are no companions', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ companions: [] }) })));
    render(<CompanionDrawer {...props} />);
    expect(await screen.findByText(/No companion files/)).toBeInTheDocument();
  });

  it('close button calls onClose', async () => {
    mockFetch();
    render(<CompanionDrawer {...props} />);
    fireEvent.click(screen.getByLabelText('Close run files'));
    expect(props.onClose).toHaveBeenCalled();
  });
});
