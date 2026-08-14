import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { vi } from 'vitest';
import { RolloutChatPanel } from './RolloutChatPanel';
import { streamRolloutChat, type ChatStreamHandlers } from '../../utils/rolloutChat';
import { makeSample, makeAttributes } from '../../test/fixtures';

// Stub the SSE stream — this test exercises the panel's rendering and the
// send → chat-bubble transition, not the network proxy (covered elsewhere).
// Individual tests override the implementation to control streaming timing;
// `vi.restoreAllMocks()` in test setup restores this default afterwards.
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

const streamMock = vi.mocked(streamRolloutChat);

/** jsdom has no layout — fake the list geometry so scroll math is testable. */
function primeScrollGeometry(el: HTMLElement, scrollTop: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
}

function sendFollowUp(text: string) {
  const ta = screen.getByPlaceholderText('Ask about this rollout…');
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: 'Enter' });
}

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

  describe('smart auto-scroll', () => {
    it('does not yank the list to the bottom when the user has scrolled up', () => {
      let handlers: ChatStreamHandlers | undefined;
      streamMock.mockImplementation((_model, _messages, h) => {
        handlers = h;
        return Promise.resolve(); // never emits — stream stays open
      });
      render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
      fireEvent.click(screen.getByText('Summarize what happened in this rollout'));
      const list = screen.getByTestId('chat-message-list');
      // 1000 - 100 - 300 = 600 from the bottom → user has scrolled up.
      primeScrollGeometry(list, 100);
      fireEvent.scroll(list);
      act(() => {
        handlers!.onText('a streamed delta');
      });
      expect(list.scrollTop).toBe(100);
    });

    it('keeps following the stream when the user is at the bottom', () => {
      let handlers: ChatStreamHandlers | undefined;
      streamMock.mockImplementation((_model, _messages, h) => {
        handlers = h;
        return Promise.resolve();
      });
      render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
      fireEvent.click(screen.getByText('Summarize what happened in this rollout'));
      const list = screen.getByTestId('chat-message-list');
      // 1000 - 700 - 300 = 0 from the bottom → pinned.
      primeScrollGeometry(list, 700);
      fireEvent.scroll(list);
      act(() => {
        handlers!.onText('a streamed delta');
      });
      expect(list.scrollTop).toBe(1000);
    });
  });

  describe('per-turn model stamping', () => {
    it('keeps earlier replies labelled with the model that produced them', () => {
      render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
      fireEvent.click(screen.getByText('Summarize what happened in this rollout'));
      const list = screen.getByTestId('chat-message-list');
      expect(within(list).getByText('Claude Opus 4.8')).toBeInTheDocument();
      // Switch the picker — the finished reply must NOT be relabelled.
      fireEvent.change(screen.getByTitle('Model to chat with'), {
        target: { value: 'gpt-5.5' },
      });
      expect(within(list).getByText('Claude Opus 4.8')).toBeInTheDocument();
      expect(within(list).queryByText('GPT-5.5')).not.toBeInTheDocument();
      // …while a new reply is stamped with the new model.
      sendFollowUp('and now?');
      expect(within(list).getByText('Claude Opus 4.8')).toBeInTheDocument();
      expect(within(list).getByText('GPT-5.5')).toBeInTheDocument();
    });

    it('never sends the model stamp in the outbound payload', () => {
      render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
      fireEvent.click(screen.getByText('Summarize what happened in this rollout'));
      sendFollowUp('again');
      const payload = streamMock.mock.calls[1][1];
      for (const m of payload) {
        expect(Object.keys(m).sort()).toEqual(['content', 'role']);
      }
    });
  });

  describe('aborted empty turns', () => {
    it('stop before the first token removes the placeholder bubble and the next payload', () => {
      streamMock.mockImplementation(() => Promise.resolve()); // hangs — no events
      render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
      fireEvent.click(screen.getByText('Did the model try to hack the reward?'));
      expect(screen.getByText('Thinking…')).toBeInTheDocument();
      fireEvent.click(screen.getByTitle('Stop'));
      expect(screen.queryByText('(no response)')).not.toBeInTheDocument();
      expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
      sendFollowUp('follow-up');
      const payload = streamMock.mock.calls[1][1];
      expect(payload.some((m) => m.role === 'assistant')).toBe(false);
      expect(payload.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    });

    it('keeps a reasoning-only aborted turn visible but out of the payload', () => {
      streamMock.mockImplementation((_model, _messages, h) => {
        h.onReasoning?.('partial thought');
        return Promise.resolve(); // hangs after reasoning
      });
      render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
      fireEvent.click(screen.getByText('Did the model try to hack the reward?'));
      fireEvent.click(screen.getByTitle('Stop'));
      // The bubble survives (it has reasoning worth reading)…
      expect(screen.getByText('partial thought')).toBeInTheDocument();
      expect(screen.queryByText('(no response)')).not.toBeInTheDocument();
      // …but the contentless assistant turn is excluded from the next request.
      sendFollowUp('follow-up');
      const payload = streamMock.mock.calls[1][1];
      expect(payload.some((m) => m.role === 'assistant')).toBe(false);
    });
  });

  describe('dirty signal + hint', () => {
    it('reports dirty state through onDirtyChange', () => {
      const onDirty = vi.fn();
      render(
        <RolloutChatPanel
          sample={makeSample()}
          isDarkMode={false}
          onClose={() => {}}
          onDirtyChange={onDirty}
        />,
      );
      expect(onDirty).toHaveBeenLastCalledWith(false);
      fireEvent.click(screen.getByText('Summarize what happened in this rollout'));
      expect(onDirty).toHaveBeenLastCalledWith(true);
    });

    it('shows the reset hint in the header context row', () => {
      render(<RolloutChatPanel sample={makeSample()} isDarkMode={false} onClose={() => {}} />);
      expect(
        screen.getByText('Discussion resets when you switch or close this rollout.'),
      ).toBeInTheDocument();
    });
  });
});
