import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PresentationPreviewPanel } from './PresentationPreviewPanel';
import { encodeImage, downloadBlob, copyImageToClipboard } from '../../utils/captureImage';
import type { PresentationMessageDraft } from '../../utils/presentationDraft';

vi.mock('../../utils/captureImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/captureImage')>();
  return {
    ...actual,
    encodeImage: vi.fn(async (blob: Blob) => blob),
    downloadBlob: vi.fn(),
    copyImageToClipboard: vi.fn(async () => true),
  };
});

const activeDraft: PresentationMessageDraft = {
  role: 'assistant',
  content: 'Shown content',
  reasoning: 'Shown reasoning',
  toolCallsJson: '',
};

const baseProps = {
  imageUrl: 'blob:fake-preview',
  imageBlob: new Blob(['fake'], { type: 'image/png' }),
  isDarkMode: false,
  imageTheme: 'light' as const,
  exportWidth: 'paper1' as const,
  fontSize: 'md' as const,
  onImageThemeChange: () => {},
  onExportWidthChange: () => {},
  onFontSizeChange: () => {},
  onCaptureStyleChange: () => {},
  activeMessageIndex: 0,
  messageLabels: ['user', 'assistant'],
  activeDraft,
  activeDraftDirty: false,
  draftCount: 0,
  onActiveMessageIndexChange: () => {},
  onActiveDraftChange: () => {},
  onResetActiveDraft: () => {},
  onClearDrafts: () => {},
};

function openCardEdit() {
  fireEvent.click(screen.getByRole('button', { name: /card edit/i }));
}

describe('PresentationPreviewPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('restores PDF as the persisted download format', () => {
    localStorage.setItem('rollout_viz_capture_format', 'pdf');
    render(<PresentationPreviewPanel {...baseProps} />);

    expect(screen.getByTitle('Download format')).toHaveValue('pdf');
  });

  it('falls back to PNG for unknown persisted download formats', () => {
    localStorage.setItem('rollout_viz_capture_format', 'docx');
    render(<PresentationPreviewPanel {...baseProps} />);

    expect(screen.getByTitle('Download format')).toHaveValue('png');
  });

  it('keeps the card editor collapsed until the bar is clicked', () => {
    render(<PresentationPreviewPanel {...baseProps} />);

    const cardEditToggle = screen.getByRole('button', { name: /card edit/i });
    expect(cardEditToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Content')).not.toBeInTheDocument();

    fireEvent.click(cardEditToggle);

    expect(cardEditToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Content')).toBeInTheDocument();
  });

  it('changes the active presentation card from the left panel', () => {
    const onActiveMessageIndexChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onActiveMessageIndexChange={onActiveMessageIndexChange} />);
    openCardEdit();

    fireEvent.change(screen.getByLabelText('Card'), { target: { value: '1' } });

    expect(onActiveMessageIndexChange).toHaveBeenCalledWith(1);
  });

  it('emits a temporary draft when the displayed content is edited', () => {
    const onActiveDraftChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onActiveDraftChange={onActiveDraftChange} />);
    openCardEdit();

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Edited for slide' } });

    expect(onActiveDraftChange).toHaveBeenCalledWith({
      ...activeDraft,
      content: 'Edited for slide',
    });
  });

  it('emits a temporary draft when the displayed role is edited', () => {
    const onActiveDraftChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onActiveDraftChange={onActiveDraftChange} />);
    openCardEdit();

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'user' } });

    expect(onActiveDraftChange).toHaveBeenCalledWith({
      ...activeDraft,
      role: 'user',
    });
  });

  it('emits a temporary draft when the displayed label is edited', () => {
    const onActiveDraftChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onActiveDraftChange={onActiveDraftChange} />);
    openCardEdit();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'GPT-5.1' } });

    expect(onActiveDraftChange).toHaveBeenCalledWith({
      ...activeDraft,
      displayLabel: 'GPT-5.1',
    });
  });

  it('labels card picker options with the message label, e.g. "#2 · assistant"', () => {
    render(<PresentationPreviewPanel {...baseProps} />);
    openCardEdit();

    expect(screen.getByRole('option', { name: '#2 · assistant' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '#1 · user' })).toBeInTheDocument();
  });

  it('shows the active card label in the collapsed Card-edit header', () => {
    render(<PresentationPreviewPanel {...baseProps} activeMessageIndex={1} />);

    expect(screen.getByRole('button', { name: /card edit/i })).toHaveTextContent('#2 · assistant');
  });

  it('downloads using exportBaseName when provided', async () => {
    render(<PresentationPreviewPanel {...baseProps} exportBaseName="my-rollout-msg3" />);

    fireEvent.click(screen.getByText('Download'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    // No nominal page width in the screen style — a screenshot has no inches.
    expect(encodeImage).toHaveBeenCalledWith(baseProps.imageBlob, 'png', undefined);
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('my-rollout-msg3.png');
  });

  it('falls back to rollout-capture for downloads without exportBaseName', async () => {
    render(<PresentationPreviewPanel {...baseProps} />);

    fireEvent.click(screen.getByText('Download'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('rollout-capture.png');
  });

  // ── Figure style (the one new capture control) ─────────────────────────

  it('renders the Figure style control defaulting to Screen', () => {
    render(<PresentationPreviewPanel {...baseProps} />);

    const screenBtn = screen.getByRole('button', { name: 'Screen' });
    const paperBtn = screen.getByRole('button', { name: 'Paper' });
    expect(screenBtn).toHaveAttribute('aria-pressed', 'true');
    expect(paperBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('emits the paper figure style when Paper is picked', () => {
    const onCaptureStyleChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onCaptureStyleChange={onCaptureStyleChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));

    expect(onCaptureStyleChange).toHaveBeenCalledWith('paper');
  });

  it('swaps the width presets to the two paper columns under Paper', () => {
    const { rerender } = render(<PresentationPreviewPanel {...baseProps} />);

    // Screen style keeps the six deck/paper-ish presets.
    expect(screen.getByRole('option', { name: 'Paper 1-column' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Column/ })).not.toBeInTheDocument();

    rerender(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);

    expect(screen.getByRole('option', { name: 'Column (3.25 in)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Full width (6.75 in)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Paper 1-column' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Slide' })).not.toBeInTheDocument();

    // …and back: the screen presets return untouched.
    rerender(<PresentationPreviewPanel {...baseProps} />);
    expect(screen.getByRole('option', { name: 'Paper 1-column' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Column (3.25 in)' })).not.toBeInTheDocument();
  });

  it('locks the image-theme and font controls while Paper is active, and frees them on Screen', () => {
    const { rerender } = render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);

    const light = screen.getByRole('button', { name: 'Light' });
    const dark = screen.getByRole('button', { name: 'Dark' });
    expect(light).toBeDisabled();
    expect(dark).toBeDisabled();
    expect(light.getAttribute('title')).toMatch(/always light/i);
    // The font control becomes a locked READOUT of the derived size, not a
    // dead dropdown (it also kept the settings row from fitting one line).
    expect(screen.queryByDisplayValue('Medium')).not.toBeInTheDocument();
    const fontLock = screen.getByTestId('paper-font-locked');
    expect(fontLock).toHaveTextContent('9pt');
    expect(fontLock.closest('[title]')?.getAttribute('title')).toMatch(/9pt/);
    // The width control stays live — it is the paper figure's one choice.
    expect(screen.getByDisplayValue('Column (3.25 in)')).toBeEnabled();

    rerender(<PresentationPreviewPanel {...baseProps} />);
    expect(screen.getByRole('button', { name: 'Light' })).toBeEnabled();
    expect(screen.getByDisplayValue('Medium')).toBeEnabled();
    expect(screen.queryByTestId('paper-font-locked')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light' })).not.toHaveAttribute('title');
  });

  it('does not fire the theme handler from a locked control', () => {
    const onImageThemeChange = vi.fn();
    render(
      <PresentationPreviewPanel
        {...baseProps}
        captureStyle="paper"
        exportWidth="col"
        onImageThemeChange={onImageThemeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(onImageThemeChange).not.toHaveBeenCalled();
  });

  // ── Download format defaults per style (round-1 critic item 6) ─────────

  it('defaults the download to PDF under Paper — a figure goes into LaTeX', () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);

    expect(screen.getByTitle('Download format')).toHaveValue('pdf');
    // PNG is not removed — it is one click away in the same picker.
    expect(screen.getByRole('option', { name: 'PNG' })).toBeInTheDocument();
  });

  it('downloads a paper PDF at the nominal COLUMN width (234pt)', async () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" exportBaseName="fig" />);

    fireEvent.click(screen.getByText('Download'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(encodeImage).toHaveBeenCalledWith(baseProps.imageBlob, 'pdf', 234);
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('fig.pdf');
  });

  it('downloads a full-width paper PDF at 486pt', async () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="full" />);

    fireEvent.click(screen.getByText('Download'));

    await waitFor(() => expect(encodeImage).toHaveBeenCalledWith(baseProps.imageBlob, 'pdf', 486));
  });

  it('lets the user opt out to PNG in Paper without demoting the screen default', () => {
    const { rerender } = render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);

    fireEvent.change(screen.getByTitle('Download format'), { target: { value: 'png' } });
    expect(screen.getByTitle('Download format')).toHaveValue('png');

    // Screen style still has its own (PNG) default and its own key…
    rerender(<PresentationPreviewPanel {...baseProps} />);
    expect(screen.getByTitle('Download format')).toHaveValue('png');
    fireEvent.change(screen.getByTitle('Download format'), { target: { value: 'jpeg' } });

    // …and coming back to Paper restores the paper choice, not the screen one.
    rerender(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);
    expect(screen.getByTitle('Download format')).toHaveValue('png');
    expect(localStorage.getItem('rollout_viz_capture_format')).toBe('jpeg');
    expect(localStorage.getItem('rollout_viz_capture_format_paper')).toBe('png');
  });

  it('keeps the clipboard on PNG even under Paper', async () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" exportBaseName="fig" />);

    fireEvent.click(screen.getByText('Copy'));

    await waitFor(() => expect(copyImageToClipboard).toHaveBeenCalledTimes(1));
    expect(copyImageToClipboard).toHaveBeenCalledWith(baseProps.imageBlob, '', 'fig.png');
    expect(encodeImage).not.toHaveBeenCalled();
  });

  // ── UX nits (round-1 critic item 9) ────────────────────────────────────

  it('names both toggle groups for assistive tech', () => {
    render(<PresentationPreviewPanel {...baseProps} />);

    expect(screen.getByRole('group', { name: 'Figure style' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Image theme' })).toBeInTheDocument();
    // …and they carry the NAME so the visible words can go: "Style" / "Theme"
    // said nothing the Screen/Paper and Light/Dark buttons don't, and were the
    // last thing pushing the settings row onto a second line under 1280px.
    expect(screen.queryByText('Style')).not.toBeInTheDocument();
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();
    expect(screen.queryByText('Figure style')).not.toBeInTheDocument();
    // The two selects keep AT/tooltip names always; their inked labels exist
    // in the DOM but are container-query-gated — hidden by default, shown
    // only when the panel is wide enough (@[34rem]), and aria-hidden either
    // way so assistive tech never hears them twice.
    for (const word of ['Width', 'Font']) {
      const label = screen.getByText(word);
      expect(label).toHaveAttribute('aria-hidden', 'true');
      expect(label.className).toContain('hidden');
      expect(label.className).toContain('@[34rem]:inline');
    }
    const width = screen.getByRole('combobox', { name: 'Export width' });
    expect(width).toHaveAttribute('title', 'Export width');
    const font = screen.getByRole('combobox', { name: 'Font size' });
    expect(font).toHaveAttribute('title', 'Font size');
  });

  it('keeps the paper font readout named even though it is not a control', () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);

    const locked = screen.getByTestId('paper-font-locked');
    expect(locked).toHaveAttribute('aria-label', 'Font size 9pt, locked');
    expect(locked).toHaveTextContent('9pt');
  });

  // ── Final-size readout (round-2 critic item 9) ─────────────────────────

  /** jsdom never decodes images: fake the raster's intrinsic size. */
  function loadPreview(w: number, h: number) {
    const img = screen.getByAltText('Live capture preview');
    Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
    fireEvent.load(img);
  }

  it('states the paper figure\'s FINAL physical size, not just its pixels', () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);
    loadPreview(1950, 785);   // a 600 DPI column raster

    // 3.25 in wide by construction; height follows the raster's aspect ratio,
    // and the supersampling factor cancels out.
    expect(screen.getByTestId('paper-size-readout')).toHaveTextContent('3.25 × 1.31 in');
  });

  it('scales the readout with the chosen column, not the pixel count', () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="full" />);
    loadPreview(4050, 4050);

    expect(screen.getByTestId('paper-size-readout')).toHaveTextContent('6.75 × 6.75 in');
  });

  it('shows no physical size for a SCREEN capture — a screenshot has none', () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="screen" />);
    loadPreview(1950, 785);

    expect(screen.queryByTestId('paper-size-readout')).not.toBeInTheDocument();
  });

  it('shows the paper-locked theme as SELECTED-but-locked, not merely off', () => {
    render(<PresentationPreviewPanel {...baseProps} captureStyle="paper" exportWidth="col" />);

    const light = screen.getByRole('button', { name: 'Light' });
    expect(light).toBeDisabled();
    expect(light).toHaveAttribute('aria-pressed', 'true');
    // Same selected fill as a live choice, dimmed — not the "unselected" wash.
    expect(light.className).toContain('bg-sky-600');
    expect(light.className).toContain('opacity-60');
    expect(light.querySelector('.material-symbols-outlined')?.textContent).toBe('lock');

    const dark = screen.getByRole('button', { name: 'Dark' });
    expect(dark).toHaveAttribute('aria-pressed', 'false');
    expect(dark.className).not.toContain('bg-sky-600');
  });

  it('passes the exportBaseName-derived fallback filename to copyImageToClipboard', async () => {
    render(<PresentationPreviewPanel {...baseProps} exportBaseName="my-rollout-msg3" />);

    fireEvent.click(screen.getByText('Copy'));

    await waitFor(() => expect(copyImageToClipboard).toHaveBeenCalledTimes(1));
    expect(copyImageToClipboard).toHaveBeenCalledWith(baseProps.imageBlob, '', 'my-rollout-msg3.png');
  });
});
