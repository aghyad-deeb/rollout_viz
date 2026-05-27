import { render, screen, fireEvent } from '@testing-library/react';
import { ElisionPill } from './ElisionPill';

const baseProps = {
  text: 'some collapsed text',
  isDarkMode: false,
  onChangeLabel: () => {},
  onRemove: () => {},
  onHide: () => {},
};

describe('ElisionPill', () => {
  it('renders [...] for single-line text with no label', () => {
    render(<ElisionPill {...baseProps} text="one line" />);
    expect(screen.getByText('[...]')).toBeInTheDocument();
  });

  it('renders [...] for multi-line text too (label is always [...])', () => {
    render(<ElisionPill {...baseProps} text={'line one\nline two\nline three'} />);
    expect(screen.getByText('[...]')).toBeInTheDocument();
  });

  it('renders the user label when provided', () => {
    render(<ElisionPill {...baseProps} label="setup omitted" />);
    expect(screen.getByText('[setup omitted]')).toBeInTheDocument();
  });

  it('left click expands (removes) the collapse', () => {
    const onRemove = vi.fn();
    render(<ElisionPill {...baseProps} onRemove={onRemove} />);
    fireEvent.click(screen.getByText('[...]'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('right click opens a menu with Edit text and Hide ellipsis', () => {
    render(<ElisionPill {...baseProps} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    expect(screen.getByText('Edit text')).toBeInTheDocument();
    expect(screen.getByText('Hide ellipsis')).toBeInTheDocument();
  });

  it('menu "Hide ellipsis" calls onHide', () => {
    const onHide = vi.fn();
    render(<ElisionPill {...baseProps} onHide={onHide} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    fireEvent.click(screen.getByText('Hide ellipsis'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('menu "Edit text" opens the label editor; Enter commits the typed label', () => {
    const onChangeLabel = vi.fn();
    const onRemove = vi.fn();
    render(<ElisionPill {...baseProps} onChangeLabel={onChangeLabel} onRemove={onRemove} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    fireEvent.click(screen.getByText('Edit text'));
    const input = screen.getByPlaceholderText('label…');
    fireEvent.change(input, { target: { value: '12 lines of boilerplate' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChangeLabel).toHaveBeenCalledWith('12 lines of boilerplate');
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('committing an empty label clears it (undefined falls back to default)', () => {
    const onChangeLabel = vi.fn();
    render(<ElisionPill {...baseProps} label="old" onChangeLabel={onChangeLabel} />);
    fireEvent.contextMenu(screen.getByText('[old]'));
    fireEvent.click(screen.getByText('Edit text'));
    const input = screen.getByPlaceholderText('label…');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChangeLabel).toHaveBeenCalledWith(undefined);
  });

  it('Escape cancels editing without committing', () => {
    const onChangeLabel = vi.fn();
    render(<ElisionPill {...baseProps} onChangeLabel={onChangeLabel} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    fireEvent.click(screen.getByText('Edit text'));
    const input = screen.getByPlaceholderText('label…');
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChangeLabel).not.toHaveBeenCalled();
    expect(screen.getByText('[...]')).toBeInTheDocument();
  });

  it('the edit input carries presentation-chrome (excluded from capture)', () => {
    render(<ElisionPill {...baseProps} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    fireEvent.click(screen.getByText('Edit text'));
    expect(screen.getByPlaceholderText('label…').className).toContain('presentation-chrome');
  });

  it('right-click menu has same-line-before / same-line-after toggles', () => {
    render(<ElisionPill {...baseProps} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    expect(screen.getByText('Same line as text before')).toBeInTheDocument();
    expect(screen.getByText('Same line as text after')).toBeInTheDocument();
  });

  it('menu "Same line as text before" calls onToggleJoinBefore', () => {
    const onToggleJoinBefore = vi.fn();
    render(<ElisionPill {...baseProps} onToggleJoinBefore={onToggleJoinBefore} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    fireEvent.click(screen.getByText('Same line as text before'));
    expect(onToggleJoinBefore).toHaveBeenCalledTimes(1);
  });

  it('menu "Same line as text after" calls onToggleJoinAfter', () => {
    const onToggleJoinAfter = vi.fn();
    render(<ElisionPill {...baseProps} onToggleJoinAfter={onToggleJoinAfter} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    fireEvent.click(screen.getByText('Same line as text after'));
    expect(onToggleJoinAfter).toHaveBeenCalledTimes(1);
  });

  it('shows a check on the active same-line toggle only', () => {
    render(<ElisionPill {...baseProps} joinBefore={true} joinAfter={false} />);
    fireEvent.contextMenu(screen.getByText('[...]'));
    const beforeIcon = screen.getByText('Same line as text before')
      .closest('button')!.querySelector('.material-symbols-outlined') as HTMLElement;
    const afterIcon = screen.getByText('Same line as text after')
      .closest('button')!.querySelector('.material-symbols-outlined') as HTMLElement;
    expect(beforeIcon.style.visibility).toBe('visible');
    expect(afterIcon.style.visibility).toBe('hidden');
  });
});
