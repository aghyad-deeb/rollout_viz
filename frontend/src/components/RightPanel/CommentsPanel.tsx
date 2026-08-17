import { useEffect, useMemo, useRef, useState } from 'react';
import type { GradeEntry, Sample } from '../../types';
import { COMMENTS_METRIC, authorOf, visibleComments } from '../../utils/humanGrades';

// Per-rollout comments ride the human-annotation rails: every comment is an
// ordinary freeform GradeEntry appended to the reserved `comments` metric
// (model: "human:<name>"), saved through the same append-only
// POST /api/save-graded merge the triage verdicts use. Nothing is ever
// rewritten — hence no EDIT affordance, and delete is a soft delete: it
// appends a signed tombstone that retracts the target entry, and every
// reader here goes through visibleComments().

/** Identity a tombstone targets, scoped to the rollout for the busy set. */
function busyKey(sampleId: number, entry: GradeEntry): string {
  return JSON.stringify([sampleId, entry.model, entry.timestamp]);
}

const NO_BUSY: ReadonlySet<string> = new Set();

// Composer auto-grow bounds (px). Floor ≈ the old rows={3}; ceiling ≈ 10 rows
// of `text-sm leading-relaxed`, after which the textarea scrolls internally.
const COMPOSER_MIN_HEIGHT = 72;
const COMPOSER_MAX_HEIGHT = 240;

interface CommentsPanelProps {
  sample: Sample | null;
  /**
   * The panel stays mounted once opened (so drafts survive a close) — this
   * only toggles visibility, mirroring App's grading-modal latch.
   */
  isOpen: boolean;
  isDarkMode: boolean;
  annotator: string;
  onAnnotatorChange: (name: string) => void;
  /** Persists one comment; resolves false when the write failed. */
  onAddComment: (sampleId: number, text: string) => Promise<boolean>;
  /**
   * Soft-deletes one comment by appending a tombstone that retracts it.
   * Resolves false when the write failed. Absent = no delete affordance
   * (shared / read-only mode).
   */
  onDeleteComment?: (sampleId: number, target: GradeEntry) => Promise<boolean>;
  onClose: () => void;
  /**
   * True while the CURRENT rollout has something the user would want to know
   * about with the drawer shut: an unposted draft or a failed save. The
   * NavigationBar toggle turns this into an amber dot.
   */
  onAttentionChange?: (attention: boolean) => void;
}

function relativeTime(timestamp: string, now: number): string {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return timestamp;
  const seconds = Math.round((now - t) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fullTime(timestamp: string): string {
  const t = Date.parse(timestamp);
  return Number.isNaN(t) ? timestamp : new Date(t).toLocaleString();
}

export function CommentsPanel({
  sample,
  isOpen,
  isDarkMode,
  annotator,
  onAnnotatorChange,
  onAddComment,
  onDeleteComment,
  onClose,
  onAttentionChange,
}: CommentsPanelProps) {
  // Drafts are keyed by sample id: switching rollouts (and closing the panel,
  // which only hides it) must never discard typed text.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  // A failed save belongs to the rollout it was written on — a save that
  // resolves after the user moved on must not raise an alarm over someone
  // else's thread, and coming back must still show it. Keyed per rollout so
  // two failures on different rollouts can't overwrite each other.
  const [errors, setErrors] = useState<Record<number, string>>({});
  // Per-card in-flight deletes, keyed by (rollout, target identity), so one
  // slow tombstone only disables its own button.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(NO_BUSY);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Clock behind the relative timestamps — ticked from an interval so
  // "5m ago" doesn't freeze while the panel sits open.
  const [now, setNow] = useState(() => Date.now());

  const sampleId = sample?.id ?? null;
  // The raw list is append-only and holds deletion tombstones; visibleComments
  // is the one true reader. Memoized so the identity is stable per sample —
  // the auto-scroll effect keys on the rendered length.
  const rawComments = sample?.grades?.[COMMENTS_METRIC];
  const comments = useMemo(() => visibleComments(rawComments), [rawComments]);
  const draft = sampleId !== null ? (drafts[sampleId] ?? '') : '';

  const visibleError = sampleId !== null ? (errors[sampleId] ?? null) : null;

  // Newest comment at the bottom — keep it in view when the panel opens, the
  // rollout changes, or a comment lands.
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [isOpen, sampleId, comments.length]);

  useEffect(() => {
    if (isOpen) textareaRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Composer auto-grow: the textarea follows its content up to ~10 rows, then
  // scrolls internally. Recomputed on every draft change (so deleting text
  // shrinks it back) and on rollout switches (drafts are per-sample).
  useEffect(() => {
    // Only measure while visible: a display:none textarea reports collapsed
    // scrollHeight, and the effect must rerun when the drawer reopens.
    if (!isOpen) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const wanted = Math.max(COMPOSER_MIN_HEIGHT, Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT));
    el.style.height = `${wanted}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [draft, sampleId, isOpen]);

  // Attention = this rollout has something the user would lose track of once
  // the drawer is shut. Reported through a ref so an unstable callback prop
  // can't re-fire the effect (callback identity discipline, see CLAUDE.md).
  const attention = draft.trim() !== '' || visibleError !== null;
  const onAttentionChangeRef = useRef(onAttentionChange);
  useEffect(() => {
    onAttentionChangeRef.current = onAttentionChange;
  }, [onAttentionChange]);
  useEffect(() => {
    onAttentionChangeRef.current?.(attention);
  }, [attention]);

  // Escape closes the panel. Guards, in the ChatView style: only while open;
  // a real modal above (grading, file browser) owns Escape first — the
  // grading modal stays mounted behind a `.hidden` wrapper, so presence in
  // the DOM alone doesn't count; and typing contexts blur instead (below),
  // so an in-progress comment is never one keystroke from being hidden.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const modalAbove = Array.from(document.querySelectorAll('[aria-modal="true"]'))
        .some(el => !el.closest('.hidden'));
      if (modalAbove) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const clearErrorFor = (id: number) => {
    setErrors(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const setDraft = (text: string) => {
    if (sampleId === null) return;
    setDrafts(prev => ({ ...prev, [sampleId]: text }));
    clearErrorFor(sampleId);
  };

  const canPost = sampleId !== null && draft.trim() !== '' && annotator.trim() !== '' && !saving;

  const post = async () => {
    // Capture the target now: the save may resolve after the user has moved
    // on, and the comment still belongs to the rollout it was written about.
    const targetId = sampleId;
    // Untrimmed snapshot of what is being posted: anything typed while the
    // write is in flight must survive the success path (below).
    const snapshot = draft;
    const text = draft.trim();
    if (targetId === null || !text || annotator.trim() === '' || saving) return;
    setSaving(true);
    // Clear only this rollout's error — a failed save on another rollout
    // keeps its banner for when the user returns to it.
    clearErrorFor(targetId);
    let ok = false;
    try {
      ok = await onAddComment(targetId, text);
    } catch {
      ok = false;
    }
    setSaving(false);
    if (!ok) {
      // The draft stays exactly where it was — never make a user retype.
      setErrors(prev => ({ ...prev, [targetId]: 'Could not save this comment. Your text is safe — try again.' }));
      return;
    }
    // Consume exactly what was posted, never more: the user may have kept
    // typing while the save was in flight. Same text → clear; text that grew
    // from it → keep only the new suffix; anything else (edited or replaced
    // mid-flight) → leave it alone rather than guess.
    setDrafts(prev => {
      const current = prev[targetId] ?? '';
      if (current === snapshot) {
        const next = { ...prev };
        delete next[targetId];
        return next;
      }
      if (current.startsWith(snapshot)) {
        return { ...prev, [targetId]: current.slice(snapshot.length) };
      }
      return prev;
    });
  };

  // Deleting works on ANY comment, not just your own: the name field is
  // honor-system, so correcting a mis-signed note means retracting someone
  // else's row. The tombstone is signed, so a name is required.
  const deleteDisabledReason = annotator.trim() === ''
    ? 'Add your name first — deletions are signed'
    : undefined;

  const requestDelete = async (entry: GradeEntry) => {
    // Capture the rollout now: the write may land after the user moves on.
    const targetId = sampleId;
    if (targetId === null || !onDeleteComment || deleteDisabledReason !== undefined) return;
    const key = busyKey(targetId, entry);
    if (deleting.has(key)) return;
    // Same guard pattern the app uses for destructive moves. The wording is
    // honest about what actually happens: the log keeps a deletion record.
    const author = authorOf(entry.model);
    if (!window.confirm(
      `Delete this comment by ${author}? The underlying log keeps a deletion record.`,
    )) return;
    setDeleting(prev => new Set(prev).add(key));
    clearErrorFor(targetId);
    let ok = false;
    try {
      ok = await onDeleteComment(targetId, entry);
    } catch {
      ok = false;
    }
    setDeleting(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (!ok) {
      setErrors(prev => ({ ...prev, [targetId]: 'Could not delete this comment. Nothing changed — try again.' }));
    }
  };

  const border = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  // `subtle` carries the timestamps and the header count: quieter than body
  // text, but the old light-mode gray-400-on-white was ~2.3:1 — below any
  // readable floor. gray-500 reads in both themes.
  const subtle = 'text-gray-500';
  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const body = isDarkMode ? 'text-gray-200' : 'text-gray-700';
  // The composer caption sits on the tinted footer, so it gets one more step
  // of contrast than the timestamps in both themes.
  const caption = isDarkMode ? 'text-gray-400' : 'text-gray-600';
  // Size is NOT baked in here: the name input wants text-xs, the composer
  // text-sm (you should read what you write at the size you read the thread).
  const fieldCls = `px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-sky-500 ${
    isDarkMode
      ? 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-500'
      : 'bg-white border-gray-300 text-gray-800 placeholder-gray-400'
  }`;

  const postDisabledReason = annotator.trim() === ''
    ? 'Add your name first — comments are signed'
    : draft.trim() === ''
      ? 'Write a comment first'
      : undefined;

  return (
    // Layout: on sm+ the drawer is a STATIC flex sibling of the content column,
    // so opening it shrinks the transcript instead of covering the third of it
    // you are annotating. Below sm there is no room to split, so it falls back
    // to a full-width overlay (absolute, against the content area's wrapper).
    <div
      className={`absolute inset-y-0 right-0 z-20 w-full max-w-full sm:static sm:shrink-0 sm:w-[24rem] flex flex-col border-l shadow-xl comments-drawer ${
        isDarkMode ? 'bg-[var(--bg-secondary)] border-[var(--border-color)]' : 'bg-white border-gray-200'
      } ${isOpen ? '' : 'hidden'}`}
      role="dialog"
      aria-label="Comments"
    >
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${border}`}>
        <span className={`material-symbols-outlined ${subtle}`} aria-hidden="true" style={{ fontSize: 18 }}>
          sticky_note_2
        </span>
        <span className={`text-sm font-semibold ${body}`}>Comments</span>
        <span className={`font-data text-xs ${subtle}`}>{comments.length}</span>
        <button
          onClick={onClose}
          aria-label="Close comments"
          title="Close comments (Esc)"
          className={`ml-auto flex items-center justify-center w-6 h-6 rounded ${
            isDarkMode ? 'hover:bg-gray-800 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
          }`}
        >
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 16 }}>close</span>
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {sample === null ? (
          <div className={`h-full flex items-center justify-center text-center text-sm px-6 ${subtle}`}>
            Select a rollout to comment on it.
          </div>
        ) : comments.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <span
              className={`flex items-center justify-center w-12 h-12 rounded-2xl mb-2 ${
                isDarkMode ? 'bg-sky-500/15 text-sky-300' : 'bg-sky-100 text-sky-600'
              }`}
            >
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 26 }}>
                sticky_note_2
              </span>
            </span>
            <div className={`text-sm ${muted}`}>No comments yet — start the thread.</div>
          </div>
        ) : (
          comments.map((entry, i) => {
            const author = authorOf(entry.model);
            const busy = sampleId !== null && deleting.has(busyKey(sampleId, entry));
            return (
              <div
                key={`${entry.timestamp}-${i}`}
                className={`group rounded-lg border px-3 py-2 ${
                  isDarkMode ? 'bg-gray-800/60 border-gray-700' : 'bg-gray-50 border-gray-200'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`text-xs font-semibold truncate ${isDarkMode ? 'text-sky-300' : 'text-sky-700'}`}>
                    {author}
                  </span>
                  <span className={`ml-auto shrink-0 text-[11px] ${subtle}`} title={fullTime(entry.timestamp)}>
                    {relativeTime(entry.timestamp, now)}
                  </span>
                  {onDeleteComment && (
                    // Quiet until you reach for it — but always reachable by
                    // keyboard (focus reveals it), never hover-only.
                    <button
                      onClick={() => requestDelete(entry)}
                      disabled={busy || deleteDisabledReason !== undefined}
                      aria-label={`Delete comment by ${author}`}
                      title={deleteDisabledReason ?? `Delete comment by ${author}`}
                      className={`shrink-0 self-center flex items-center justify-center w-5 h-5 rounded transition-opacity ${
                        busy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100'
                      } ${
                        deleteDisabledReason !== undefined
                          ? 'cursor-not-allowed text-gray-400'
                          : isDarkMode
                            ? 'text-gray-400 hover:text-red-300 hover:bg-red-900/30'
                            : 'text-gray-500 hover:text-red-600 hover:bg-red-50'
                      }`}
                    >
                      <span
                        className={`material-symbols-outlined ${busy ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                        style={{ fontSize: 14 }}
                      >
                        {busy ? 'progress_activity' : 'delete'}
                      </span>
                    </button>
                  )}
                </div>
                <div className={`mt-1 text-sm whitespace-pre-wrap break-words ${body}`}>
                  {String(entry.grade)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {visibleError !== null && (
        <div
          role="alert"
          className={`mx-3 mb-1 px-3 py-2 text-xs rounded-lg flex items-start gap-1.5 ${
            isDarkMode
              ? 'bg-red-900/40 text-red-300'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          <span className="material-symbols-outlined shrink-0" aria-hidden="true" style={{ fontSize: 14 }}>error</span>
          <span className="flex-1">{visibleError}</span>
        </div>
      )}

      <div className={`p-3 border-t ${border} bg-[var(--bg-tertiary)]`}>
        <div className="flex items-center gap-2 mb-2">
          <label htmlFor="comment-author" className={`text-[11px] shrink-0 ${muted}`}>
            Your name <span aria-hidden="true" className={isDarkMode ? 'text-red-400' : 'text-red-500'}>*</span>
          </label>
          <input
            id="comment-author"
            type="text"
            required
            // Pins the accessible name to the field's own label text, so the
            // required marker above stays purely visual.
            aria-label="Your name"
            aria-required="true"
            value={annotator}
            onChange={(e) => onAnnotatorChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Blur only — Escape must not bubble up and hide the panel.
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            placeholder="e.g. ada"
            className={`flex-1 min-w-0 text-xs ${fieldCls}`}
          />
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              post();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
          disabled={sample === null}
          rows={3}
          placeholder="Leave a comment — Ctrl+Enter to post"
          aria-label="Comment"
          className={`w-full resize-y text-sm leading-relaxed ${fieldCls} disabled:opacity-50`}
        />
        <div className="flex items-center gap-2 mt-2">
          {/* The reason Post is unavailable belongs on the page, not only in a
              tooltip on a disabled button (which many browsers never show). */}
          {postDisabledReason !== undefined ? (
            <span
              className={`text-[11px] ${
                draft.trim() !== ''
                  // Something is written and can't go out — that's a blocker.
                  ? (isDarkMode ? 'text-amber-300' : 'text-amber-700')
                  // Nothing written yet — guidance, not a warning.
                  : caption
              }`}
            >
              {postDisabledReason}
            </span>
          ) : (
            <span className={`text-[11px] ${caption}`}>Saved with the rollout — visible to everyone.</span>
          )}
          <button
            onClick={post}
            disabled={!canPost}
            title={postDisabledReason}
            className={`ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
              isDarkMode ? 'bg-sky-700 text-white hover:bg-sky-600' : 'bg-sky-600 text-white hover:bg-sky-700'
            }`}
          >
            {saving && (
              <span
                className="material-symbols-outlined animate-spin"
                aria-hidden="true"
                style={{ fontSize: 14 }}
              >
                progress_activity
              </span>
            )}
            {saving ? 'Posting…' : 'Post'}
          </button>
        </div>
      </div>
    </div>
  );
}
