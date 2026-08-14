import { describe, it, expect } from 'vitest';
import type { GradeEntry } from '../types';
import {
  COMMENT_DELETE_PROMPT_VERSION,
  buildCommentTombstone,
  isCommentTombstone,
  mergeAppendOnlyGrades,
  visibleComments,
} from './humanGrades';

// Comment lists are append-only, so a delete is one MORE entry: a tombstone
// naming its target by (model, timestamp). visibleComments is the one true
// reader — everything user-facing (badge, column, drawer, filters) goes
// through it.

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

const textsOf = (list: GradeEntry[]) => list.map(e => String(e.grade));

describe('isCommentTombstone', () => {
  it('is false for an ordinary comment', () => {
    expect(isCommentTombstone(comment('a note', 'ada', '2026-08-08T07:26:08.671Z'))).toBe(false);
  });

  it('is true for the comment-delete-v1 prompt version', () => {
    const entry = { ...comment('', 'ada', '2026-08-09T00:00:00.000Z'), prompt_version: COMMENT_DELETE_PROMPT_VERSION };
    expect(isCommentTombstone(entry)).toBe(true);
  });

  it('is true for any entry carrying a deletes field, whatever its prompt version', () => {
    const entry = {
      ...comment('', 'ada', '2026-08-09T00:00:00.000Z'),
      deletes: { model: 'human:grace', timestamp: '2026-08-08T07:26:08.671Z' },
    };
    expect(isCommentTombstone(entry)).toBe(true);
  });
});

describe('buildCommentTombstone', () => {
  const target = comment('a wrong note', 'grace', '2026-08-08T07:26:08.671Z');

  it('targets the entry by its (model, timestamp) pair', () => {
    const t = buildCommentTombstone(target, 'ada');
    expect(t.deletes).toEqual({ model: 'human:grace', timestamp: '2026-08-08T07:26:08.671Z' });
  });

  it('is a signed, empty freeform entry stamped comment-delete-v1', () => {
    const t = buildCommentTombstone(target, 'ada');
    expect(t.grade).toBe('');
    expect(t.grade_type).toBe('freeform');
    expect(t.quotes).toEqual([]);
    expect(t.model).toBe('human:ada');
    expect(t.prompt_version).toBe(COMMENT_DELETE_PROMPT_VERSION);
    expect(Number.isNaN(Date.parse(t.timestamp))).toBe(false);
  });

  it('explains, in prose, what it retracts', () => {
    expect(buildCommentTombstone(target, 'ada').explanation)
      .toBe('deleted comment by human:grace from 2026-08-08T07:26:08.671Z');
  });

  it('signs an empty annotator as anonymous rather than dropping the signature', () => {
    expect(buildCommentTombstone(target, '').model).toBe('human:anonymous');
  });

  it('reads as a tombstone', () => {
    expect(isCommentTombstone(buildCommentTombstone(target, 'ada'))).toBe(true);
  });
});

describe('visibleComments', () => {
  it('returns [] for an absent or empty list', () => {
    expect(visibleComments(undefined)).toEqual([]);
    expect(visibleComments([])).toEqual([]);
  });

  it('passes an untouched list through with its identity intact', () => {
    const list = Object.freeze([comment('one', 'ada', 't1'), comment('two', 'grace', 't2')]) as GradeEntry[];
    // Same array, not a copy — memo hooks key on this identity.
    expect(visibleComments(list)).toBe(list);
  });

  it('hides the targeted entry', () => {
    const doomed = comment('typo', 'ada', 't1');
    const list = [comment('keep me', 'grace', 't0'), doomed, buildCommentTombstone(doomed, 'ada')];
    expect(textsOf(visibleComments(list))).toEqual(['keep me']);
  });

  it('never shows the tombstones themselves', () => {
    const doomed = comment('typo', 'ada', 't1');
    const list = [doomed, buildCommentTombstone(doomed, 'ada')];
    expect(visibleComments(list)).toEqual([]);
  });

  it('applies multiple tombstones, keeping the survivors in order', () => {
    const a = comment('a', 'ada', 't1');
    const b = comment('b', 'grace', 't2');
    const c = comment('c', 'ada', 't3');
    const list = [a, b, c, buildCommentTombstone(a, 'ada'), buildCommentTombstone(c, 'grace')];
    expect(textsOf(visibleComments(list))).toEqual(['b']);
  });

  it('treats a tombstone with no matching target as inert', () => {
    const list = [
      comment('still here', 'ada', 't1'),
      buildCommentTombstone(comment('never existed', 'grace', 't9'), 'ada'),
    ];
    expect(textsOf(visibleComments(list))).toEqual(['still here']);
  });

  it('needs BOTH model and timestamp to match', () => {
    const entry = comment('keep', 'ada', 't1');
    const sameAuthor = buildCommentTombstone(comment('x', 'ada', 't2'), 'ada');
    const sameStamp = buildCommentTombstone(comment('x', 'grace', 't1'), 'ada');
    expect(textsOf(visibleComments([entry, sameAuthor, sameStamp]))).toEqual(['keep']);
  });

  it('hides every entry sharing one (model, timestamp) pair — one tombstone, all gone', () => {
    // Only reachable via direct API writes; the UI can't mint two identical
    // pairs. Documented behaviour: they are indistinguishable, so both go.
    const twin = comment('dupe', 'ada', 't1');
    const list = [twin, { ...twin, grade: 'dupe two' }, comment('other', 'grace', 't2'), buildCommentTombstone(twin, 'ada')];
    expect(textsOf(visibleComments(list))).toEqual(['other']);
  });

  it('does not resurrect a deleted comment when a later one is added', () => {
    const doomed = comment('gone', 'ada', 't1');
    const list = [doomed, buildCommentTombstone(doomed, 'ada'), comment('after', 'ada', 't3')];
    expect(textsOf(visibleComments(list))).toEqual(['after']);
  });

  it('ignores a tombstone that arrives before its target in the list', () => {
    // Order-independent: the merge appends, but a hand-written log could
    // interleave. Matching is by identity, not position.
    const doomed = comment('gone', 'ada', 't1');
    const list = [buildCommentTombstone(doomed, 'ada'), doomed];
    expect(visibleComments(list)).toEqual([]);
  });
});

describe('mergeAppendOnlyGrades', () => {
  // Hydration replaces a sample with a freshly fetched copy; grade lists are
  // append-only, so per metric the longer list is the newer one. This is what
  // keeps a tombstone appended mid-flight from being clobbered by a stale
  // response.
  it('keeps the local list when it is longer than the fetched one', () => {
    const doomed = comment('gone', 'ada', 't1');
    const local = { comments: [doomed, buildCommentTombstone(doomed, 'ada')] };
    const fetched = { comments: [doomed] };
    expect(mergeAppendOnlyGrades(local, fetched)!.comments).toHaveLength(2);
  });

  it('takes the fetched list when it is the longer one', () => {
    const a = comment('a', 'ada', 't1');
    const local = { comments: [a] };
    const fetched = { comments: [a, comment('b', 'grace', 't2')] };
    expect(mergeAppendOnlyGrades(local, fetched)!.comments).toHaveLength(2);
  });

  it('unions metrics present on only one side', () => {
    const local = { comments: [comment('a', 'ada', 't1')] };
    const fetched = { accuracy: [comment('x', 'judge', 't2')] };
    const merged = mergeAppendOnlyGrades(local, fetched)!;
    expect(Object.keys(merged).sort()).toEqual(['accuracy', 'comments']);
  });

  it('passes through when either side is absent', () => {
    const grades = { comments: [comment('a', 'ada', 't1')] };
    expect(mergeAppendOnlyGrades(undefined, grades)).toBe(grades);
    expect(mergeAppendOnlyGrades(grades, undefined)).toBe(grades);
  });
});
