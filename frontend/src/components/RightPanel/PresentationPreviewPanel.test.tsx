import { render, screen, fireEvent } from '@testing-library/react';
import { PresentationPreviewPanel } from './PresentationPreviewPanel';
import type { PresentationMessageDraft } from '../../utils/presentationDraft';

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
  activeMessageIndex: 0,
  messageCount: 2,
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
  beforeEach(() => localStorage.clear());

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
});
