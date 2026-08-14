import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LibraryView } from './index';

const RESPONSE = {
  generated_at: '2026-07-04T21:00:00',
  from_cache: false,
  kinds: [
    {
      kind: 'evals',
      title: 'Evals',
      total_group_count: 2,
      groups: [
        {
          name: 'ae_20260701_205543',
          prefix: 's3://rewardseeker/logs_jsonl/auto_eval/ae_20260701_205543/',
          last_modified: '2026-07-01T21:00:00',
          file_count: 2,
          total_bytes: 4096,
          graded: true,
          files: [
            {
              path: 's3://rewardseeker/logs_jsonl/auto_eval/ae_20260701_205543/runs/run_01/target.jsonl',
              name: 'runs/run_01/target.jsonl',
              size: 2048,
              last_modified: '2026-07-01T21:00:00',
              graded: true,
            },
            {
              path: 's3://rewardseeker/logs_jsonl/auto_eval/ae_20260701_205543/runs/run_02/target.jsonl',
              name: 'runs/run_02/target.jsonl',
              size: 2048,
              last_modified: '2026-07-01T20:00:00',
              graded: false,
            },
          ],
        },
      ],
    },
    {
      kind: 'training_runs',
      title: 'Training runs',
      total_group_count: 0,
      groups: [],
    },
    {
      kind: 'chats',
      title: 'Chats',
      total_group_count: 1,
      groups: [
        {
          name: '2026-07-04',
          prefix: 's3://rewardseeker/logs_jsonl/online_chats/2026-07-04/',
          last_modified: '2026-07-04T04:28:00',
          file_count: 1,
          total_bytes: 1000,
          graded: false,
          files: [
            {
              path: 's3://rewardseeker/logs_jsonl/online_chats/2026-07-04/x/chat.jsonl',
              name: 'x/chat.jsonl',
              size: 1000,
              last_modified: '2026-07-04T04:28:00',
              graded: false,
            },
          ],
        },
      ],
    },
  ],
};

const PREVIEW = {
  available: true,
  experiment_name: 'exp',
  model_id: 'gpt-x',
  first_user_message: 'Explore the maze and map it',
  message_count: 12,
};

function mockFetch() {
  const fn = vi.fn((url: string) => {
    if (String(url).startsWith('/api/library/preview')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(PREVIEW) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(RESPONSE) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const props = {
  isDarkMode: false,
  onOpenFile: vi.fn(),
  onOpenFileBrowser: vi.fn(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('LibraryView', () => {
  it('renders kinds with groups, hides empty kinds, shows graded badge', async () => {
    mockFetch();
    render(<LibraryView {...props} />);
    expect(await screen.findByText('ae_20260701_205543')).toBeInTheDocument();
    expect(screen.getByText('Evals')).toBeInTheDocument();
    expect(screen.getByText('Chats')).toBeInTheDocument();
    expect(screen.queryByText('Training runs')).not.toBeInTheDocument(); // empty kind hidden
    expect(screen.getByText('graded')).toBeInTheDocument();
  });

  it('expanding a group lists its files and fetches a lazy preview', async () => {
    const fetchFn = mockFetch();
    render(<LibraryView {...props} />);
    fireEvent.click(await screen.findByText('ae_20260701_205543'));
    expect(screen.getByText('runs/run_01/target.jsonl')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Explore the maze/)).toBeInTheDocument());
    const previewCalls = fetchFn.mock.calls.filter((c) => String(c[0]).includes('/api/library/preview'));
    expect(previewCalls).toHaveLength(1);
    expect(String(previewCalls[0][0])).toContain(encodeURIComponent(RESPONSE.kinds[0].groups[0].files[0].path));
  });

  it('clicking a file opens it', async () => {
    mockFetch();
    render(<LibraryView {...props} />);
    fireEvent.click(await screen.findByText('ae_20260701_205543'));
    fireEvent.click(screen.getByText('runs/run_02/target.jsonl'));
    expect(props.onOpenFile).toHaveBeenCalledWith([
      's3://rewardseeker/logs_jsonl/auto_eval/ae_20260701_205543/runs/run_02/target.jsonl',
    ]);
  });

  it('"Load all" opens every file in the group via multi-file loading', async () => {
    mockFetch();
    render(<LibraryView {...props} />);
    fireEvent.click(await screen.findByText('ae_20260701_205543'));
    fireEvent.click(screen.getByText('Load all 2 files'));
    expect(props.onOpenFile).toHaveBeenCalledWith([
      's3://rewardseeker/logs_jsonl/auto_eval/ae_20260701_205543/runs/run_01/target.jsonl',
      's3://rewardseeker/logs_jsonl/auto_eval/ae_20260701_205543/runs/run_02/target.jsonl',
    ]);
  });

  it('falls back to Browse when the library fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))));
    render(<LibraryView {...props} />);
    expect(await screen.findByText(/Library unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Browse all files…'));
    expect(props.onOpenFileBrowser).toHaveBeenCalled();
  });
});
