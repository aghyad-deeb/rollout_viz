import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { ChatMessageCard } from './ChatMessageCard';

describe('ChatMessageCard', () => {
  it('renders a user turn labelled "You"', () => {
    render(
      <ChatMessageCard role="user" content="hello there" isDarkMode={false} modelLabel="GPT-5.5" />,
    );
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('labels an assistant turn with the model name', () => {
    render(
      <ChatMessageCard
        role="assistant"
        content="the answer"
        isDarkMode={false}
        modelLabel="Claude Opus 4.7"
      />,
    );
    expect(screen.getByText('Claude Opus 4.7')).toBeInTheDocument();
    expect(screen.getByText('the answer')).toBeInTheDocument();
  });

  it('renders streamed reasoning in its own block', () => {
    const { container } = render(
      <ChatMessageCard
        role="assistant"
        content=""
        reasoning="let me think"
        isDarkMode={false}
        modelLabel="GPT-5.5"
        isStreaming
      />,
    );
    expect(screen.getByText('let me think')).toBeInTheDocument();
    expect(container.querySelector('.reasoning')).not.toBeNull();
  });

  it('shows a Thinking… placeholder while streaming with no output yet', () => {
    render(
      <ChatMessageCard
        role="assistant"
        content=""
        isDarkMode={false}
        modelLabel="GPT-5.5"
        isStreaming
      />,
    );
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
  });

  it('shows (no response) when a finished assistant turn is empty', () => {
    render(
      <ChatMessageCard role="assistant" content="" isDarkMode={false} modelLabel="GPT-5.5" />,
    );
    expect(screen.getByText('(no response)')).toBeInTheDocument();
  });

  it('offers a copy button only for a finished assistant turn with content', () => {
    const { rerender } = render(
      <ChatMessageCard role="assistant" content="done" isDarkMode={false} modelLabel="GPT-5.5" />,
    );
    expect(screen.getByTitle('Copy message')).toBeInTheDocument();
    // Still streaming → no copy button yet.
    rerender(
      <ChatMessageCard
        role="assistant"
        content="partial"
        isDarkMode={false}
        modelLabel="GPT-5.5"
        isStreaming
      />,
    );
    expect(screen.queryByTitle('Copy message')).not.toBeInTheDocument();
    // User turns never get a copy button.
    rerender(<ChatMessageCard role="user" content="hi" isDarkMode={false} modelLabel="GPT-5.5" />);
    expect(screen.queryByTitle('Copy message')).not.toBeInTheDocument();
  });

  it('renders assistant content as markdown-lite (no raw sigils)', () => {
    const { container } = render(
      <ChatMessageCard
        role="assistant"
        content={'a **bold** claim with `code`'}
        isDarkMode={false}
        modelLabel="GPT-5.5"
      />,
    );
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('`');
  });

  it('renders an unclosed streaming fence as a code block, caret after it', () => {
    const { container } = render(
      <ChatMessageCard
        role="assistant"
        content={'look:\n```py\nprint(1)'}
        isDarkMode={false}
        modelLabel="GPT-5.5"
        isStreaming
      />,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('print(1)');
    expect(container.textContent).not.toContain('```');
  });

  it('leaves user turns and reasoning verbatim', () => {
    const { container, rerender } = render(
      <ChatMessageCard role="user" content="a **bold** move" isDarkMode={false} modelLabel="GPT-5.5" />,
    );
    expect(screen.getByText('a **bold** move')).toBeInTheDocument();
    rerender(
      <ChatMessageCard
        role="assistant"
        content="fine"
        reasoning="raw **reasoning** text"
        isDarkMode={false}
        modelLabel="GPT-5.5"
      />,
    );
    expect(container.textContent).toContain('raw **reasoning** text');
  });

  it('copy button copies the raw markdown string, not the rendered form', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <ChatMessageCard
        role="assistant"
        content={'**raw** sigils stay'}
        isDarkMode={false}
        modelLabel="GPT-5.5"
      />,
    );
    fireEvent.click(screen.getByTitle('Copy message'));
    expect(writeText).toHaveBeenCalledWith('**raw** sigils stay');
  });
});
