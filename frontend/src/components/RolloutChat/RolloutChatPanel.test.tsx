import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { RolloutChatPanel } from './RolloutChatPanel';
import { makeSample, makeAttributes } from '../../test/fixtures';

// Stub the SSE stream — this test exercises the panel's rendering and the
// send → chat-bubble transition, not the network proxy (covered elsewhere).
vi.mock('../../utils/rolloutChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/rolloutChat')>();
  return {
    ...actual,
    streamRolloutChat: vi.fn((_model, _messages, handlers) => {
      handlers.onText('stubbed reply');
      handlers.onDone();
      return Promise.resolve();
    }),
  };
});

describe('RolloutChatPanel', () => {
  it('shows the empty state with rollout context and starter chips', () => {
    const sample = makeSample({
      attributes: { ...makeAttributes(), experiment_name: 'exp-z', rollout_n: 4, step: 2 },
    });
    render(<RolloutChatPanel sample={sample} isDarkMode={false} onClose={() => {}} />);
    expect(screen.getByText('Discuss rollout')).toBeInTheDocument();
    expect(screen.getByText('exp-z')).toBeInTheDocument(); // rollout-context subtitle
    expect(screen.getByText('Ask anything about this rollout')).toBeInTheDocument();
    expect(screen.getByText('Did the model try to hack the reward?')).toBeInTheDocument();
  });

  it('prompts to pick a rollout when none is selected', () => {
    render(<RolloutChatPanel sample={null} isDarkMode={false} onClose={() => {}} />);
    expect(screen.getByText('Select a rollout to discuss it.')).toBeInTheDocument();
  });

  it('clicking a starter chip sends it and renders the exchange as cards', () => {
    render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
    fireEvent.click(screen.getByText('What mistakes did the model make?'));
    // The empty state is replaced by the question + the streamed reply.
    expect(screen.queryByText('Ask anything about this rollout')).not.toBeInTheDocument();
    expect(screen.getByText('What mistakes did the model make?')).toBeInTheDocument();
    expect(screen.getByText('stubbed reply')).toBeInTheDocument();
  });
});
