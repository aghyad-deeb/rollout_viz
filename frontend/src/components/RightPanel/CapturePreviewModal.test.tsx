import { render, screen, fireEvent } from '@testing-library/react';
import { CapturePreviewModal } from './CapturePreviewModal';

const baseProps = {
  imageUrl: 'blob:fake-preview',
  isDarkMode: false,
  onCopy: () => {},
  onDownload: () => {},
  onClose: () => {},
};

describe('CapturePreviewModal', () => {
  it('renders the preview image from the given URL', () => {
    render(<CapturePreviewModal {...baseProps} />);
    expect(screen.getByAltText('Capture preview')).toHaveAttribute('src', 'blob:fake-preview');
  });

  it('Copy button invokes onCopy and shows feedback', async () => {
    const onCopy = vi.fn();
    render(<CapturePreviewModal {...baseProps} onCopy={onCopy} />);
    fireEvent.click(screen.getByText('Copy to clipboard'));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });

  it('Download button invokes onDownload', () => {
    const onDownload = vi.fn();
    render(<CapturePreviewModal {...baseProps} onDownload={onDownload} />);
    fireEvent.click(screen.getByText('Download'));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('Escape key invokes onClose', () => {
    const onClose = vi.fn();
    render(<CapturePreviewModal {...baseProps} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click invokes onClose but a click on the panel does not', () => {
    const onClose = vi.fn();
    render(<CapturePreviewModal {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByAltText('Capture preview'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('capture-preview-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
