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

  it('changes the active presentation card from the left panel', () => {
    const onActiveMessageIndexChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onActiveMessageIndexChange={onActiveMessageIndexChange} />);

    fireEvent.change(screen.getByLabelText('Card'), { target: { value: '1' } });

    expect(onActiveMessageIndexChange).toHaveBeenCalledWith(1);
  });

  it('emits a temporary draft when the displayed content is edited', () => {
    const onActiveDraftChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onActiveDraftChange={onActiveDraftChange} />);

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Edited for slide' } });

    expect(onActiveDraftChange).toHaveBeenCalledWith({
      ...activeDraft,
      content: 'Edited for slide',
    });
  });

  it('emits a temporary draft when the displayed role is edited', () => {
    const onActiveDraftChange = vi.fn();
    render(<PresentationPreviewPanel {...baseProps} onActiveDraftChange={onActiveDraftChange} />);

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'user' } });

    expect(onActiveDraftChange).toHaveBeenCalledWith({
      ...activeDraft,
      role: 'user',
    });
  });
});
