import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { CommentsPanel } from './CommentsPanel';
import { NavigationBar } from './NavigationBar';
import { makeSample } from '../../test/fixtures';
import { COMMENTS_METRIC, buildCommentTombstone } from '../../utils/humanGrades';
import type { GradeEntry, Sample, ViewMode } from '../../types';

type CommentsPanelProps = ComponentProps<typeof CommentsPanel>;

function comment(text: string, author: string, timestamp: string): GradeEntry {
  return {
    grade: text,
    grade_type: 'freeform',
    quotes: [],
    explanation: '',
    model: `human:${author}`,
    prompt_version: 'comment-v1',
    timestamp,
  };
}

/** Timestamp `secondsAgo` before now, in the ISO form buildHumanEntry writes. */
function ago(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function sampleWith(comments: GradeEntry[], id = 0): Sample {
  return makeSample({ id, grades: { [COMMENTS_METRIC]: comments } });
}

function makeProps(overrides: Partial<CommentsPanelProps> = {}): CommentsPanelProps {
  return {
    sample: makeSample({ id: 0 }),
    isOpen: true,
    isDarkMode: false,
    annotator: 'ada',
    onAnnotatorChange: vi.fn(),
    onAddComment: vi.fn().mockResolvedValue(true),
    onDeleteComment: vi.fn().mockResolvedValue(true),
    onClose: vi.fn(),
    ...overrides,
  };
}

const composer = () => screen.getByLabelText('Comment') as HTMLTextAreaElement;
const postButton = () => screen.getByRole('button', { name: 'Post' });
const deleteButton = (author: string) => screen.getByLabelText(`Delete comment by ${author}`);

describe('CommentsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('comment list', () => {
    it('renders author, relative time, and text for each comment, oldest first', () => {
      const sample = sampleWith([
        comment('First thought', 'ada', ago(3 * 24 * 3600)),
        comment('Follow-up', 'grace', ago(2 * 3600)),
        comment('Latest', 'ada', ago(5)),
      ]);
      render(<CommentsPanel {...makeProps({ sample })} />);

      expect(screen.getByText('First thought')).toBeInTheDocument();
      expect(screen.getByText('Follow-up')).toBeInTheDocument();
      expect(screen.getByText('Latest')).toBeInTheDocument();
      expect(screen.getByText('grace')).toBeInTheDocument();
      // 'human:' prefix is stripped for display.
      expect(screen.queryByText('human:ada')).not.toBeInTheDocument();

      expect(screen.getByText('3d ago')).toBeInTheDocument();
      expect(screen.getByText('2h ago')).toBeInTheDocument();
      expect(screen.getByText('just now')).toBeInTheDocument();

      // Chronological: oldest at the top of the DOM order.
      const texts = screen.getAllByText(/First thought|Follow-up|Latest/).map(el => el.textContent);
      expect(texts).toEqual(['First thought', 'Follow-up', 'Latest']);
    });

    it('carries the full timestamp in the relative time tooltip', () => {
      const iso = ago(5 * 60);
      render(<CommentsPanel {...makeProps({ sample: sampleWith([comment('note', 'ada', iso)]) })} />);
      const stamp = screen.getByText('5m ago');
      expect(stamp).toHaveAttribute('title', new Date(iso).toLocaleString());
    });

    it('shows a non-human model string as-is', () => {
      const entry = { ...comment('auto note', 'x', ago(10)), model: 'gpt-5.5' };
      render(<CommentsPanel {...makeProps({ sample: sampleWith([entry]) })} />);
      expect(screen.getByText('gpt-5.5')).toBeInTheDocument();
    });

    it('renders a list mixing human and non-human authors', () => {
      const sample = sampleWith([
        comment('human first', 'ada', ago(3600)),
        { ...comment('machine note', 'x', ago(600)), model: 'gpt-5.5' },
        comment('human last', 'grace', ago(5)),
      ]);
      render(<CommentsPanel {...makeProps({ sample })} />);
      const texts = screen.getAllByText(/human first|machine note|human last/).map(el => el.textContent);
      expect(texts).toEqual(['human first', 'machine note', 'human last']);
      expect(screen.getByText('ada')).toBeInTheDocument();
      expect(screen.getByText('gpt-5.5')).toBeInTheDocument();
      expect(screen.getByText('grace')).toBeInTheDocument();
    });

    it('shows an empty state when the rollout has no comments', () => {
      render(<CommentsPanel {...makeProps()} />);
      expect(screen.getByText('No comments yet — start the thread.')).toBeInTheDocument();
    });

    it('prompts for a selection when no sample is loaded', () => {
      render(<CommentsPanel {...makeProps({ sample: null })} />);
      expect(screen.getByText('Select a rollout to comment on it.')).toBeInTheDocument();
      expect(composer()).toBeDisabled();
    });

    it('hides soft-deleted comments and the tombstones themselves', () => {
      const doomed = comment('retracted', 'ada', ago(3600));
      const sample = sampleWith([
        comment('kept', 'grace', ago(7200)),
        doomed,
        buildCommentTombstone(doomed, 'grace'),
      ]);
      render(<CommentsPanel {...makeProps({ sample })} />);

      expect(screen.getByText('kept')).toBeInTheDocument();
      expect(screen.queryByText('retracted')).not.toBeInTheDocument();
      // The tombstone's own prose never leaks into the thread either.
      expect(screen.queryByText(/deleted comment by/)).not.toBeInTheDocument();
    });

    it('counts only visible comments in the header', () => {
      const doomed = comment('retracted', 'ada', ago(3600));
      const sample = sampleWith([
        comment('kept', 'grace', ago(7200)),
        doomed,
        buildCommentTombstone(doomed, 'grace'),
      ]);
      const { container } = render(<CommentsPanel {...makeProps({ sample })} />);
      const header = container.querySelector('.border-b') as HTMLElement;
      expect(header.textContent).toContain('1');
      expect(header.textContent).not.toContain('3');
    });

    it('falls back to the empty state when every comment has been deleted', () => {
      const doomed = comment('only one', 'ada', ago(60));
      const sample = sampleWith([doomed, buildCommentTombstone(doomed, 'ada')]);
      render(<CommentsPanel {...makeProps({ sample })} />);
      expect(screen.getByText('No comments yet — start the thread.')).toBeInTheDocument();
    });
  });

  describe('deleting a comment', () => {
    const CONFIRM_TEXT = 'Delete this comment by grace? The underlying log keeps a deletion record.';

    function withConfirm(answer: boolean) {
      return vi.spyOn(window, 'confirm').mockReturnValue(answer);
    }

    // The confirm spy is installed on the real window — hand it back so it
    // can't leak into the tests that follow.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('confirms, then deletes the exact target entry', async () => {
      const confirm = withConfirm(true);
      const target = comment('wrong call', 'grace', ago(600));
      const onDeleteComment = vi.fn().mockResolvedValue(true);
      render(<CommentsPanel {...makeProps({ sample: sampleWith([target], 4), onDeleteComment })} />);

      await act(async () => {
        fireEvent.click(deleteButton('grace'));
      });

      expect(confirm).toHaveBeenCalledWith(CONFIRM_TEXT);
      expect(onDeleteComment).toHaveBeenCalledWith(4, target);
    });

    it('does nothing when the confirm is declined', async () => {
      withConfirm(false);
      const onDeleteComment = vi.fn().mockResolvedValue(true);
      render(<CommentsPanel {...makeProps({ sample: sampleWith([comment('x', 'grace', ago(60))]), onDeleteComment })} />);

      await act(async () => {
        fireEvent.click(deleteButton('grace'));
      });

      expect(onDeleteComment).not.toHaveBeenCalled();
      expect(screen.getByText('x')).toBeInTheDocument();
    });

    it('works on someone else\'s comment as well as your own', async () => {
      withConfirm(true);
      const onDeleteComment = vi.fn().mockResolvedValue(true);
      const mine = comment('mine', 'ada', ago(600));
      const theirs = comment('theirs', 'grace', ago(300));
      render(<CommentsPanel {...makeProps({ sample: sampleWith([mine, theirs]), onDeleteComment })} />);

      await act(async () => {
        fireEvent.click(deleteButton('ada'));
      });
      await act(async () => {
        fireEvent.click(deleteButton('grace'));
      });

      expect(onDeleteComment).toHaveBeenNthCalledWith(1, 0, mine);
      expect(onDeleteComment).toHaveBeenNthCalledWith(2, 0, theirs);
    });

    it('drops the comment from the list once the sample prop reflects the tombstone', async () => {
      withConfirm(true);
      const target = comment('goodbye', 'grace', ago(600));
      const kept = comment('stays', 'ada', ago(900));
      const props = makeProps({ sample: sampleWith([kept, target]) });
      const { rerender } = render(<CommentsPanel {...props} />);
      expect(screen.getByText('goodbye')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(deleteButton('grace'));
      });
      // App mirrors the appended tombstone into samples state.
      rerender(
        <CommentsPanel {...props} sample={sampleWith([kept, target, buildCommentTombstone(target, 'ada')])} />,
      );

      expect(screen.queryByText('goodbye')).not.toBeInTheDocument();
      expect(screen.getByText('stays')).toBeInTheDocument();
    });

    it('is disabled with an explanation while the name is empty', () => {
      const onDeleteComment = vi.fn();
      render(
        <CommentsPanel
          {...makeProps({ annotator: '', sample: sampleWith([comment('x', 'grace', ago(60))]), onDeleteComment })}
        />,
      );
      const button = deleteButton('grace');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Add your name first — deletions are signed');
      fireEvent.click(button);
      expect(onDeleteComment).not.toHaveBeenCalled();
    });

    it('treats a whitespace-only name like an empty one', () => {
      render(
        <CommentsPanel {...makeProps({ annotator: '   ', sample: sampleWith([comment('x', 'grace', ago(60))]) })} />,
      );
      expect(deleteButton('grace')).toBeDisabled();
    });

    it('disables only the busy card while its tombstone is in flight', async () => {
      withConfirm(true);
      let resolveDelete: (ok: boolean) => void = () => {};
      const onDeleteComment = vi.fn(() => new Promise<boolean>(r => { resolveDelete = r; }));
      render(
        <CommentsPanel
          {...makeProps({
            sample: sampleWith([comment('one', 'grace', ago(600)), comment('two', 'ada', ago(300))]),
            onDeleteComment,
          })}
        />,
      );

      fireEvent.click(deleteButton('grace'));
      expect(deleteButton('grace')).toBeDisabled();
      // The sibling card is untouched.
      expect(deleteButton('ada')).toBeEnabled();
      // A second click on the busy card cannot double-write.
      fireEvent.click(deleteButton('grace'));

      await act(async () => {
        resolveDelete(true);
      });
      expect(onDeleteComment).toHaveBeenCalledTimes(1);
      expect(deleteButton('grace')).toBeEnabled();
    });

    it('surfaces a scoped error when the delete fails, keeping the comment and the draft', async () => {
      withConfirm(true);
      const onDeleteComment = vi.fn().mockResolvedValue(false);
      const props = makeProps({ sample: sampleWith([comment('survivor', 'grace', ago(600)), ], 1), onDeleteComment });
      const { rerender } = render(<CommentsPanel {...props} />);

      fireEvent.change(composer(), { target: { value: 'unrelated draft' } });
      await act(async () => {
        fireEvent.click(deleteButton('grace'));
      });

      expect(screen.getByRole('alert')).toHaveTextContent('Could not delete this comment');
      expect(screen.getByText('survivor')).toBeInTheDocument();
      expect(composer().value).toBe('unrelated draft');

      // Scoped to the rollout it was attempted on.
      rerender(<CommentsPanel {...props} sample={sampleWith([], 2)} />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('surfaces the same error when onDeleteComment rejects', async () => {
      withConfirm(true);
      const onDeleteComment = vi.fn().mockRejectedValue(new Error('offline'));
      render(<CommentsPanel {...makeProps({ sample: sampleWith([comment('x', 'grace', ago(60))]), onDeleteComment })} />);

      await act(async () => {
        fireEvent.click(deleteButton('grace'));
      });
      expect(screen.getByRole('alert')).toHaveTextContent('Could not delete this comment');
    });

    it('offers no delete affordance when deletion is unavailable', () => {
      render(
        <CommentsPanel
          {...makeProps({ sample: sampleWith([comment('x', 'grace', ago(60))]), onDeleteComment: undefined })}
        />,
      );
      expect(screen.queryByLabelText(/^Delete comment/)).not.toBeInTheDocument();
    });

    it('is keyboard-reachable, only visually quiet until hover or focus', () => {
      render(<CommentsPanel {...makeProps({ sample: sampleWith([comment('x', 'grace', ago(60))]) })} />);
      const cls = deleteButton('grace').className;
      expect(cls).toContain('opacity-0');
      expect(cls).toContain('group-hover:opacity-100');
      expect(cls).toContain('focus:opacity-100');
    });
  });

  describe('composer', () => {
    it('disables Post while the comment text is empty', () => {
      render(<CommentsPanel {...makeProps()} />);
      expect(postButton()).toBeDisabled();
      fireEvent.change(composer(), { target: { value: 'looks like a hack' } });
      expect(postButton()).toBeEnabled();
    });

    it('disables Post while the name is empty, explaining why', () => {
      render(<CommentsPanel {...makeProps({ annotator: '' })} />);
      fireEvent.change(composer(), { target: { value: 'something' } });
      expect(postButton()).toBeDisabled();
      expect(postButton()).toHaveAttribute('title', 'Add your name first — comments are signed');
    });

    it('treats whitespace-only text as empty', () => {
      render(<CommentsPanel {...makeProps()} />);
      fireEvent.change(composer(), { target: { value: '   \n ' } });
      expect(postButton()).toBeDisabled();
    });

    it('treats a whitespace-only name like an empty one', () => {
      render(<CommentsPanel {...makeProps({ annotator: '  \n  ' })} />);
      fireEvent.change(composer(), { target: { value: 'something' } });
      expect(postButton()).toBeDisabled();
    });

    it('posts with (sampleId, trimmed text) and clears the draft on success', async () => {
      const onAddComment = vi.fn().mockResolvedValue(true);
      render(<CommentsPanel {...makeProps({ sample: makeSample({ id: 7 }), onAddComment })} />);

      fireEvent.change(composer(), { target: { value: '  reward hacked the test  ' } });
      await act(async () => {
        fireEvent.click(postButton());
      });

      expect(onAddComment).toHaveBeenCalledWith(7, 'reward hacked the test');
      expect(composer().value).toBe('');
    });

    it('Ctrl+Enter posts', async () => {
      const onAddComment = vi.fn().mockResolvedValue(true);
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'quick note' } });
      await act(async () => {
        fireEvent.keyDown(composer(), { key: 'Enter', ctrlKey: true });
      });

      expect(onAddComment).toHaveBeenCalledWith(0, 'quick note');
    });

    it('Cmd+Enter posts too', async () => {
      const onAddComment = vi.fn().mockResolvedValue(true);
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'mac note' } });
      await act(async () => {
        fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true });
      });

      expect(onAddComment).toHaveBeenCalledWith(0, 'mac note');
    });

    it('plain Enter does not post (newlines are allowed)', () => {
      const onAddComment = vi.fn().mockResolvedValue(true);
      render(<CommentsPanel {...makeProps({ onAddComment })} />);
      fireEvent.change(composer(), { target: { value: 'line one' } });
      fireEvent.keyDown(composer(), { key: 'Enter' });
      expect(onAddComment).not.toHaveBeenCalled();
    });

    it('shows a spinner and blocks re-posting while a save is in flight', async () => {
      let resolveSave: (ok: boolean) => void = () => {};
      const onAddComment = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'slow save' } });
      fireEvent.click(postButton());

      const posting = await screen.findByRole('button', { name: /Posting/ });
      expect(posting).toBeDisabled();
      expect(posting.querySelector('.animate-spin')).not.toBeNull();

      await act(async () => {
        resolveSave(true);
      });
      expect(onAddComment).toHaveBeenCalledTimes(1);
      expect(composer().value).toBe('');
    });

    it('keeps the draft and surfaces an error when the save fails', async () => {
      const onAddComment = vi.fn().mockResolvedValue(false);
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'precious text' } });
      await act(async () => {
        fireEvent.click(postButton());
      });

      expect(screen.getByRole('alert')).toHaveTextContent('Could not save this comment');
      expect(composer().value).toBe('precious text');
      expect(postButton()).toBeEnabled();
    });

    it('keeps the draft when onAddComment rejects', async () => {
      const onAddComment = vi.fn().mockRejectedValue(new Error('offline'));
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'precious text' } });
      await act(async () => {
        fireEvent.click(postButton());
      });

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(composer().value).toBe('precious text');
    });

    it('clears the error once the user edits the draft again', async () => {
      const onAddComment = vi.fn().mockResolvedValue(false);
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'text' } });
      await act(async () => {
        fireEvent.click(postButton());
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();

      fireEvent.change(composer(), { target: { value: 'text!' } });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('attributes a slow save to the rollout it was written on, not the current one', async () => {
      let resolveSave: (ok: boolean) => void = () => {};
      const onAddComment = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
      const props = makeProps({ sample: makeSample({ id: 1 }), onAddComment });
      const { rerender } = render(<CommentsPanel {...props} />);

      fireEvent.change(composer(), { target: { value: 'about rollout 1' } });
      fireEvent.click(postButton());
      expect(onAddComment).toHaveBeenCalledWith(1, 'about rollout 1');

      // User moves on and starts typing about rollout 2 before the write lands.
      rerender(<CommentsPanel {...props} sample={makeSample({ id: 2 })} />);
      fireEvent.change(composer(), { target: { value: 'about rollout 2' } });
      await act(async () => {
        resolveSave(true);
      });

      // Only rollout 1's draft was consumed.
      expect(composer().value).toBe('about rollout 2');
      rerender(<CommentsPanel {...props} sample={makeSample({ id: 1 })} />);
      expect(composer().value).toBe('');
    });
  });

  describe('in-flight typing', () => {
    it('keeps text typed while the save was in flight', async () => {
      let resolveSave: (ok: boolean) => void = () => {};
      const onAddComment = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'first thought' } });
      fireEvent.click(postButton());
      // …the user keeps typing before the write lands.
      fireEvent.change(composer(), { target: { value: 'first thought and a second one' } });
      await act(async () => {
        resolveSave(true);
      });

      expect(onAddComment).toHaveBeenCalledWith(0, 'first thought');
      // Only the posted prefix is consumed.
      expect(composer().value).toBe(' and a second one');
    });

    it('clears the draft when nothing was typed during the save', async () => {
      let resolveSave: (ok: boolean) => void = () => {};
      const onAddComment = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'just this' } });
      fireEvent.click(postButton());
      await act(async () => {
        resolveSave(true);
      });

      expect(composer().value).toBe('');
    });

    it('leaves a draft rewritten mid-flight completely untouched', async () => {
      let resolveSave: (ok: boolean) => void = () => {};
      const onAddComment = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
      render(<CommentsPanel {...makeProps({ onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'posted text' } });
      fireEvent.click(postButton());
      // Replaced, not appended to — we can't tell what was consumed, so keep all.
      fireEvent.change(composer(), { target: { value: 'a totally different note' } });
      await act(async () => {
        resolveSave(true);
      });

      expect(composer().value).toBe('a totally different note');
    });
  });

  describe('attention signal', () => {
    it('reports a non-empty draft, and its clearing', () => {
      const onAttentionChange = vi.fn();
      render(<CommentsPanel {...makeProps({ onAttentionChange })} />);
      expect(onAttentionChange).toHaveBeenLastCalledWith(false);

      fireEvent.change(composer(), { target: { value: 'half a thought' } });
      expect(onAttentionChange).toHaveBeenLastCalledWith(true);

      fireEvent.change(composer(), { target: { value: '   ' } });
      expect(onAttentionChange).toHaveBeenLastCalledWith(false);
    });

    it('reports a failed save even after the draft is posted-and-kept', async () => {
      const onAttentionChange = vi.fn();
      const onAddComment = vi.fn().mockResolvedValue(false);
      render(<CommentsPanel {...makeProps({ onAttentionChange, onAddComment })} />);

      fireEvent.change(composer(), { target: { value: 'doomed' } });
      await act(async () => {
        fireEvent.click(postButton());
      });
      expect(onAttentionChange).toHaveBeenLastCalledWith(true);
    });

    it('follows the rollout: a draft on one sample does not flag another', () => {
      const onAttentionChange = vi.fn();
      const props = makeProps({ onAttentionChange, sample: makeSample({ id: 1 }) });
      const { rerender } = render(<CommentsPanel {...props} />);

      fireEvent.change(composer(), { target: { value: 'about one' } });
      expect(onAttentionChange).toHaveBeenLastCalledWith(true);

      rerender(<CommentsPanel {...props} sample={makeSample({ id: 2 })} />);
      expect(onAttentionChange).toHaveBeenLastCalledWith(false);

      rerender(<CommentsPanel {...props} sample={makeSample({ id: 1 })} />);
      expect(onAttentionChange).toHaveBeenLastCalledWith(true);
    });
  });

  describe('composer affordances', () => {
    it('renders the comment text at reading size, not the name-field size', () => {
      render(<CommentsPanel {...makeProps()} />);
      expect(composer().className).toContain('text-sm');
      expect(composer().className).not.toContain('text-xs');
      expect((screen.getByLabelText('Your name') as HTMLInputElement).className).toContain('text-xs');
    });

    it('marks the name field as required', () => {
      render(<CommentsPanel {...makeProps()} />);
      const input = screen.getByLabelText('Your name');
      expect(input).toBeRequired();
      expect(input).toHaveAttribute('aria-required', 'true');
    });

    it('spells out why Post is unavailable, inline', () => {
      const { rerender } = render(<CommentsPanel {...makeProps({ annotator: '' })} />);
      expect(screen.getByText('Add your name first — comments are signed')).toBeInTheDocument();

      rerender(<CommentsPanel {...makeProps({ annotator: 'ada' })} />);
      expect(screen.getByText('Write a comment first')).toBeInTheDocument();

      fireEvent.change(composer(), { target: { value: 'ready' } });
      expect(screen.queryByText('Write a comment first')).not.toBeInTheDocument();
      expect(screen.getByText('Saved with the rollout — visible to everyone.')).toBeInTheDocument();
    });

    it('grows with the content and shrinks back', () => {
      render(<CommentsPanel {...makeProps()} />);
      const el = composer();
      // jsdom reports scrollHeight 0, so stub it like a real wrapped textarea.
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 400 });
      fireEvent.change(el, { target: { value: 'x\n'.repeat(40) } });
      // Capped at ~10 rows, then it scrolls internally.
      expect(el.style.height).toBe('240px');
      expect(el.style.overflowY).toBe('auto');

      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 20 });
      fireEvent.change(el, { target: { value: '' } });
      expect(el.style.height).toBe('72px');
      expect(el.style.overflowY).toBe('hidden');
    });
  });

  describe('draft persistence', () => {
    it('keeps a per-sample draft across sample switches', () => {
      const props = makeProps({ sample: makeSample({ id: 1 }) });
      const { rerender } = render(<CommentsPanel {...props} />);

      fireEvent.change(composer(), { target: { value: 'draft for one' } });

      rerender(<CommentsPanel {...props} sample={makeSample({ id: 2 })} />);
      expect(composer().value).toBe('');
      fireEvent.change(composer(), { target: { value: 'draft for two' } });

      rerender(<CommentsPanel {...props} sample={makeSample({ id: 1 })} />);
      expect(composer().value).toBe('draft for one');

      rerender(<CommentsPanel {...props} sample={makeSample({ id: 2 })} />);
      expect(composer().value).toBe('draft for two');
    });

    it('keeps the draft across a close/reopen (the panel only hides)', () => {
      const props = makeProps();
      const { rerender } = render(<CommentsPanel {...props} />);

      fireEvent.change(composer(), { target: { value: 'half-written' } });
      rerender(<CommentsPanel {...props} isOpen={false} />);
      rerender(<CommentsPanel {...props} isOpen={true} />);

      expect(composer().value).toBe('half-written');
    });

    it('drops a stale save error when the rollout changes', async () => {
      const props = makeProps({ sample: makeSample({ id: 1 }), onAddComment: vi.fn().mockResolvedValue(false) });
      const { rerender } = render(<CommentsPanel {...props} />);

      fireEvent.change(composer(), { target: { value: 'text' } });
      await act(async () => {
        fireEvent.click(postButton());
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();

      rerender(<CommentsPanel {...props} sample={makeSample({ id: 2 })} />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // …and shows it again on the rollout it actually belongs to.
      rerender(<CommentsPanel {...props} sample={makeSample({ id: 1 })} />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it("posting on another rollout does not wipe the first rollout's save error", async () => {
      const onAddComment = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      const props = makeProps({ sample: makeSample({ id: 1 }), onAddComment });
      const { rerender } = render(<CommentsPanel {...props} />);

      // Failed save on rollout 1.
      fireEvent.change(composer(), { target: { value: 'doomed' } });
      await act(async () => {
        fireEvent.click(postButton());
      });
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Successful post on rollout 2.
      rerender(<CommentsPanel {...props} sample={makeSample({ id: 2 })} />);
      fireEvent.change(composer(), { target: { value: 'fine here' } });
      await act(async () => {
        fireEvent.click(postButton());
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // Rollout 1 still owes the user its error (and its draft).
      rerender(<CommentsPanel {...props} sample={makeSample({ id: 1 })} />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(composer().value).toBe('doomed');
    });
  });

  describe('name field', () => {
    it('is bound to the annotator prop and reports edits upward', () => {
      const onAnnotatorChange = vi.fn();
      render(<CommentsPanel {...makeProps({ annotator: 'ada', onAnnotatorChange })} />);
      const input = screen.getByLabelText('Your name') as HTMLInputElement;
      expect(input.value).toBe('ada');
      fireEvent.change(input, { target: { value: 'grace' } });
      expect(onAnnotatorChange).toHaveBeenCalledWith('grace');
    });
  });

  describe('close affordances', () => {
    it('closes via the header button', () => {
      const onClose = vi.fn();
      render(<CommentsPanel {...makeProps({ onClose })} />);
      fireEvent.click(screen.getByLabelText('Close comments'));
      expect(onClose).toHaveBeenCalled();
    });

    it('Escape closes the panel when it is open', () => {
      const onClose = vi.fn();
      render(<CommentsPanel {...makeProps({ onClose })} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
    });

    it('Escape does nothing while the panel is hidden', () => {
      const onClose = vi.fn();
      render(<CommentsPanel {...makeProps({ onClose, isOpen: false })} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Escape in the composer blurs instead of closing, keeping the draft', () => {
      const onClose = vi.fn();
      render(<CommentsPanel {...makeProps({ onClose })} />);
      fireEvent.change(composer(), { target: { value: 'keep me' } });
      fireEvent.keyDown(composer(), { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
      expect(composer().value).toBe('keep me');
    });

    it('yields Escape to a visible modal above it', () => {
      const onClose = vi.fn();
      const modal = document.createElement('div');
      modal.setAttribute('aria-modal', 'true');
      document.body.appendChild(modal);
      try {
        render(<CommentsPanel {...makeProps({ onClose })} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
      } finally {
        modal.remove();
      }
    });

    it('still closes when the only aria-modal in the DOM is a hidden one', () => {
      const onClose = vi.fn();
      // App keeps the grading modal mounted behind a `.hidden` wrapper.
      const wrapper = document.createElement('div');
      wrapper.className = 'hidden';
      const modal = document.createElement('div');
      modal.setAttribute('aria-modal', 'true');
      wrapper.appendChild(modal);
      document.body.appendChild(wrapper);
      try {
        render(<CommentsPanel {...makeProps({ onClose })} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalled();
      } finally {
        wrapper.remove();
      }
    });
  });

  describe('visibility and theming', () => {
    it('hides itself (without unmounting) when isOpen is false', () => {
      render(<CommentsPanel {...makeProps({ isOpen: false })} />);
      const panel = screen.getByRole('dialog', { name: 'Comments' });
      expect(panel.className).toContain('hidden');
    });

    it('renders in dark mode', () => {
      render(
        <CommentsPanel
          {...makeProps({ isDarkMode: true, sample: sampleWith([comment('dark note', 'ada', ago(30))]) })}
        />,
      );
      const panel = screen.getByRole('dialog', { name: 'Comments' });
      expect(panel.className).toContain('bg-gray-900');
      expect(screen.getByText('dark note')).toBeInTheDocument();
      expect(postButton().className).toContain('bg-sky-700');
    });

    it('scrolls the newest comment into view when opened', async () => {
      const props = makeProps({ sample: sampleWith([comment('old', 'ada', ago(600))]) });
      const { rerender, container } = render(<CommentsPanel {...props} isOpen={false} />);
      const list = container.querySelector('.custom-scrollbar') as HTMLElement;
      Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true });

      rerender(<CommentsPanel {...props} isOpen={true} />);
      await waitFor(() => expect(list.scrollTop).toBe(900));
    });
  });
});

// The toolbar affordance lives in NavigationBar; its badge is the only place
// the comment count surfaces outside the panel.
describe('NavigationBar comments toggle', () => {
  type NavProps = ComponentProps<typeof NavigationBar>;
  function navProps(overrides: Partial<NavProps> = {}): NavProps {
    return {
      sample: makeSample(),
      experimentName: 'test_exp',
      navPos: 0,
      navTotal: 1,
      onNavigate: vi.fn(),
      isDarkMode: false,
      filePath: 'test.jsonl',
      generateLink: vi.fn(() => 'http://localhost:3000/?file=test.jsonl'),
      viewMode: 'chat' as ViewMode,
      onViewModeChange: vi.fn(),
      onToggleComments: vi.fn(),
      ...overrides,
    };
  }

  it('toggles the panel and reflects the open state', () => {
    const onToggleComments = vi.fn();
    const { rerender } = render(<NavigationBar {...navProps({ onToggleComments })} />);
    const button = screen.getByRole('button', { name: 'Comments (0)' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(onToggleComments).toHaveBeenCalled();

    rerender(<NavigationBar {...navProps({ onToggleComments, isCommentsOpen: true })} />);
    expect(screen.getByRole('button', { name: 'Comments (0)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('badges the count and puts it in the tooltip', () => {
    render(<NavigationBar {...navProps({ commentCount: 3 })} />);
    const button = screen.getByRole('button', { name: 'Comments (3)' });
    expect(button).toHaveAttribute('title', 'Comments (3)');
    expect(button).toHaveTextContent('3');
  });

  it('caps the badge at 9+', () => {
    render(<NavigationBar {...navProps({ commentCount: 42 })} />);
    expect(screen.getByRole('button', { name: 'Comments (42)' })).toHaveTextContent('9+');
  });

  it('shows no badge when there are no comments', () => {
    render(<NavigationBar {...navProps({ commentCount: 0 })} />);
    const button = screen.getByRole('button', { name: 'Comments (0)' });
    // sticky_note_2, not the `forum` family the LLM discussion chat owns.
    expect(button.textContent).toBe('sticky_note_2');
  });

  it('shows an amber attention dot, distinct from the count badge', () => {
    const { rerender } = render(<NavigationBar {...navProps({ commentCount: 2 })} />);
    expect(screen.queryByTestId('comments-attention-dot')).not.toBeInTheDocument();

    rerender(<NavigationBar {...navProps({ commentCount: 2, commentsAttention: true })} />);
    const dot = screen.getByTestId('comments-attention-dot');
    expect(dot.className).toContain('amber');
    // The count badge still reads 2 — the dot is a separate signal.
    expect(screen.getByRole('button', { name: 'Comments (2)' })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Comments (2)' }))
      .toHaveAttribute('title', 'Comments (2) · unposted draft');
  });

  it('is hidden in shared (read-only) mode and without a selected sample', () => {
    const { rerender } = render(<NavigationBar {...navProps({ isSharedMode: true })} />);
    expect(screen.queryByRole('button', { name: /^Comments/ })).not.toBeInTheDocument();
    rerender(<NavigationBar {...navProps({ sample: null, navPos: -1 })} />);
    expect(screen.queryByRole('button', { name: /^Comments/ })).not.toBeInTheDocument();
  });
});
