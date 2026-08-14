import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileBrowser } from './index';

// URL-aware fetch stub: /api/files/* (recursive browse) returns a flat array,
// /api/contents/* (navigate) returns { folders, files }.
function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.startsWith('/api/files/') ? [] : { folders: [], files: [] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderBrowser() {
  return render(
    <FileBrowser
      isOpen={true}
      onClose={vi.fn()}
      onSelectFiles={vi.fn()}
      markedFiles={new Set()}
      onToggleMark={vi.fn()}
      isDarkMode={false}
    />,
  );
}

const OPEN_TITLE = 'Navigate into folder to see subfolders';
const BROWSE_TITLE = 'Browse all JSONL files recursively';

// The modal auto-fetches its default path on open, which disables the
// Open/Browse buttons until it settles.
async function waitForInitialLoad() {
  await waitFor(() => expect(screen.getByTitle(OPEN_TITLE)).not.toBeDisabled());
}

describe('FileBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives Open the primary styling and Browse All the secondary styling', async () => {
    stubFetch();
    renderBrowser();
    await waitForInitialLoad();

    expect(screen.getByTitle(OPEN_TITLE).className).toContain('bg-blue-600');
    expect(screen.getByTitle(BROWSE_TITLE).className).not.toContain('bg-blue-600');
    expect(screen.getByTitle(BROWSE_TITLE).className).toContain('border');
  });

  it('renders S3 breadcrumbs whose targets keep the trailing slash', async () => {
    const fetchMock = stubFetch();
    renderBrowser();
    await waitForInitialLoad();

    fireEvent.change(screen.getByPlaceholderText(/s3:\/\/bucket\/prefix/), {
      target: { value: 's3://bucket/a/b/c/' },
    });
    fireEvent.click(screen.getByTitle(OPEN_TITLE));

    // Last segment is plain text (current location), ancestors are buttons
    const crumbB = await screen.findByRole('button', { name: 'b' });
    expect(screen.getByRole('button', { name: 's3://bucket' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'c' })).not.toBeInTheDocument();

    fireEvent.click(crumbB);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/contents/s3?bucket=${encodeURIComponent('bucket')}&prefix=${encodeURIComponent('a/b/')}`,
      );
    });
  });

  it('renders clickable local breadcrumbs targeting ancestor directories', async () => {
    const fetchMock = stubFetch();
    renderBrowser();
    await waitForInitialLoad();

    fireEvent.change(screen.getByPlaceholderText(/s3:\/\/bucket\/prefix/), {
      target: { value: '/home/ubuntu/data' },
    });
    fireEvent.click(screen.getByTitle(OPEN_TITLE));

    const crumb = await screen.findByRole('button', { name: 'ubuntu' });
    expect(screen.queryByRole('button', { name: 'data' })).not.toBeInTheDocument();

    fireEvent.click(crumb);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/contents/local?directory=${encodeURIComponent('/home/ubuntu')}`,
      );
    });
  });

  it('keeps the plain path and recursive badge in browse mode', async () => {
    stubFetch();
    renderBrowser();
    await waitForInitialLoad();

    fireEvent.click(screen.getByTitle(BROWSE_TITLE));

    await screen.findByText('recursive');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByText('s3://rewardseeker/logs_jsonl/')).toBeInTheDocument();
  });
});
