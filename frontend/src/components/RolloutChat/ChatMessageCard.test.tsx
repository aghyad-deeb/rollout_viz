import { render, screen } from '@testing-library/react';
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
});
