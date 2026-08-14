import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { NavigationBar } from './NavigationBar';
import { makeSample } from '../../test/fixtures';
import type { ViewMode } from '../../types';

type NavigationBarProps = ComponentProps<typeof NavigationBar>;

function makeProps(overrides: Partial<NavigationBarProps> = {}): NavigationBarProps {
  return {
    sample: makeSample(),
    experimentName: 'test_exp',
    navPos: 1,
    navTotal: 5,
    onNavigate: vi.fn(),
    isDarkMode: false,
    filePath: 'test.jsonl',
    generateLink: vi.fn(() => 'http://localhost:3000/?file=test.jsonl'),
    viewMode: 'chat' as ViewMode,
    onViewModeChange: vi.fn(),
    ...overrides,
  };
}

describe('NavigationBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('view mode switcher', () => {
    it('orders the buttons Chat | Analysis | Evidence | Eval | Meta', () => {
      render(<NavigationBar {...makeProps()} />);
      const buttons = screen.getAllByRole('button');
      expect(buttons[0]).toHaveTextContent('Chat');
      expect(buttons[1]).toHaveTextContent('Analysis');
      expect(buttons[2]).toHaveTextContent('Evidence');
      expect(buttons[3]).toHaveTextContent('Eval');
      expect(buttons[4]).toHaveTextContent('Meta');
      // Chat leads the segmented control, Meta closes it.
      expect(buttons[0].className).toContain('rounded-l-md');
      expect(buttons[0].className).not.toContain('border-l');
      expect(buttons[4].className).toContain('rounded-r-md');
    });

    it('switches to the Evidence view', () => {
      const props = makeProps();
      render(<NavigationBar {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /Evidence/ }));
      expect(props.onViewModeChange).toHaveBeenCalledWith('evidence');
    });

    it('disables the Eval and Meta placeholders with a Coming soon hint', () => {
      const props = makeProps();
      render(<NavigationBar {...props} />);
      const evalButton = screen.getByRole('button', { name: 'Eval' });
      const metaButton = screen.getByRole('button', { name: 'Meta' });
      expect(evalButton).toBeDisabled();
      expect(metaButton).toBeDisabled();
      expect(evalButton).toHaveAttribute('title', 'Coming soon');
      expect(metaButton).toHaveAttribute('title', 'Coming soon');
      fireEvent.click(evalButton);
      fireEvent.click(metaButton);
      expect(props.onViewModeChange).not.toHaveBeenCalled();
    });

    it('keeps Chat and Analysis clickable', () => {
      const props = makeProps();
      render(<NavigationBar {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'Analysis' }));
      expect(props.onViewModeChange).toHaveBeenCalledWith('analysis');
    });
  });

  describe('triage toggle', () => {
    it('toggles triage mode and reflects the active state', () => {
      const onToggleTriageMode = vi.fn();
      const { rerender } = render(
        <NavigationBar {...makeProps({ onToggleTriageMode })} />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Enter Triage Mode' }));
      expect(onToggleTriageMode).toHaveBeenCalled();

      rerender(<NavigationBar {...makeProps({ onToggleTriageMode, isTriageMode: true })} />);
      expect(screen.getByRole('button', { name: 'Exit Triage Mode' })).toHaveTextContent('Triaging');
    });
  });

  describe('navigation arrows', () => {
    it('disables first/prev at the start of the filtered list', () => {
      render(<NavigationBar {...makeProps({ navPos: 0, navTotal: 3 })} />);
      expect(screen.getByRole('button', { name: 'First sample' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Previous sample (K)' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Next sample (J)' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Last sample' })).toBeEnabled();
    });

    it('disables next/last at the end of the filtered list', () => {
      render(<NavigationBar {...makeProps({ navPos: 2, navTotal: 3 })} />);
      expect(screen.getByRole('button', { name: 'First sample' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Previous sample (K)' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Next sample (J)' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Last sample' })).toBeDisabled();
    });

    it('enables all arrows in the middle of the list', () => {
      render(<NavigationBar {...makeProps({ navPos: 1, navTotal: 3 })} />);
      expect(screen.getByRole('button', { name: 'First sample' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Previous sample (K)' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Next sample (J)' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Last sample' })).toBeEnabled();
    });

    it('disables all arrows when no sample is selected', () => {
      render(<NavigationBar {...makeProps({ sample: null, navPos: -1, navTotal: 3 })} />);
      expect(screen.getByRole('button', { name: 'First sample' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Previous sample (K)' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Next sample (J)' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Last sample' })).toBeDisabled();
    });
  });

  describe('position indicator', () => {
    it('shows the 1-based position within the filtered list', () => {
      render(<NavigationBar {...makeProps({ navPos: 1, navTotal: 5 })} />);
      expect(screen.getByText('2 / 5')).toBeInTheDocument();
    });

    it('hides the indicator when no sample is in the list', () => {
      render(<NavigationBar {...makeProps({ sample: null, navPos: -1, navTotal: 5 })} />);
      expect(screen.queryByText(/\d+ \/ \d+/)).not.toBeInTheDocument();
    });
  });

  describe('diagnostics pill', () => {
    it('shows an amber diag pill with the producer diagnostics in the tooltip', () => {
      const sample = makeSample({
        id: 0,
        diagnostics: ['Display reconstruction from samples.jsonl', 'truncated at 10 turns'],
      });
      render(<NavigationBar {...makeProps({ sample })} />);
      const pill = screen.getByText('diag');
      expect(pill).toHaveAttribute(
        'title',
        'Producer diagnostics:\nDisplay reconstruction from samples.jsonl\ntruncated at 10 turns',
      );
    });

    it('renders no pill when diagnostics are absent or empty', () => {
      const { rerender } = render(<NavigationBar {...makeProps()} />);
      expect(screen.queryByText('diag')).not.toBeInTheDocument();
      rerender(<NavigationBar {...makeProps({ sample: makeSample({ id: 0, diagnostics: [] }) })} />);
      expect(screen.queryByText('diag')).not.toBeInTheDocument();
    });
  });

  describe('open in web_chat', () => {
    const chatSample = () =>
      makeSample({
        id: 0,
        attributes: {
          ...makeSample().attributes,
          chat_id: 'chat_20260704_120000_abc',
          branch_id: 'branch_7',
        },
      });
    const chatFile = 's3://rewardseeker/logs_jsonl/chats/2026-07-04/x/chat.jsonl';

    it('links to web_chat by S3 key with the branch when configured', () => {
      render(
        <NavigationBar
          {...makeProps({
            sample: chatSample(),
            filePath: chatFile,
            webChatBaseUrl: 'http://localhost:5173',
          })}
        />,
      );
      const link = screen.getByRole('link', { name: 'Open this chat in web_chat' });
      expect(link).toHaveAttribute(
        'href',
        'http://localhost:5173/?chat=logs_jsonl%2Fchats%2F2026-07-04%2Fx%2Fchat.jsonl&branch=branch_7',
      );
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('hidden without a configured base URL', () => {
      render(<NavigationBar {...makeProps({ sample: chatSample(), filePath: chatFile })} />);
      expect(screen.queryByRole('link', { name: 'Open this chat in web_chat' })).not.toBeInTheDocument();
    });

    it('hidden for samples without a chat_id', () => {
      render(
        <NavigationBar
          {...makeProps({ filePath: chatFile, webChatBaseUrl: 'http://localhost:5173' })}
        />,
      );
      expect(screen.queryByRole('link', { name: 'Open this chat in web_chat' })).not.toBeInTheDocument();
    });

    it('hidden for non-rewardseeker files (web_chat loads by S3 key)', () => {
      render(
        <NavigationBar
          {...makeProps({
            sample: chatSample(),
            filePath: 'local/chats/chat.jsonl',
            webChatBaseUrl: 'http://localhost:5173',
          })}
        />,
      );
      expect(screen.queryByRole('link', { name: 'Open this chat in web_chat' })).not.toBeInTheDocument();
    });
  });

  describe('copy link feedback', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('flashes Copied for 2 seconds after a successful clipboard write', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      render(<NavigationBar {...makeProps()} />);
      const button = screen.getByRole('button', { name: 'Copy link to this sample' });

      await act(async () => {
        fireEvent.click(button);
      });

      expect(writeText).toHaveBeenCalledWith('http://localhost:3000/?file=test.jsonl');
      expect(button).toHaveTextContent('Copied');
      expect(button.querySelector('.material-symbols-outlined')).toHaveTextContent('check');

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(button).not.toHaveTextContent('Copied');
      expect(button.querySelector('.material-symbols-outlined')).toHaveTextContent('link');
    });

    it('stays silent when the clipboard write is rejected', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      render(<NavigationBar {...makeProps()} />);
      const button = screen.getByRole('button', { name: 'Copy link to this sample' });

      await act(async () => {
        fireEvent.click(button);
      });

      expect(writeText).toHaveBeenCalled();
      expect(button).not.toHaveTextContent('Copied');
      expect(button.querySelector('.material-symbols-outlined')).toHaveTextContent('link');
    });
  });
});
