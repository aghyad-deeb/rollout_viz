import type { GradeEntry, GradeType, Sample, SampleGrades } from '../types';

/**
 * Human verdicts are ordinary GradeEntry rows appended to the same
 * append-only per-metric lists the LLM judges write to (via the existing
 * POST /api/save-graded merge). `model: "human:<name>"` is what
 * distinguishes them — every existing surface (grade columns, the filter
 * mini-language, Analysis, the grades panel with its run-history pager)
 * lights up for free, and the judge's earlier entries stay in the history.
 */

export const TRIAGE_METRIC = 'human_verdict';

/**
 * Free-text per-rollout comments. Same rails as the verdicts: one freeform
 * GradeEntry per comment, appended to this reserved metric. The merge is
 * append-only, so a comment is never edited or removed from the log —
 * deleting one appends a TOMBSTONE instead (see below).
 */
export const COMMENTS_METRIC = 'comments';

/** prompt_version stamped on a comment. */
export const COMMENT_PROMPT_VERSION = 'comment-v1';
/** prompt_version stamped on a comment tombstone (a soft delete). */
export const COMMENT_DELETE_PROMPT_VERSION = 'comment-delete-v1';

/** The fixed v1 verdict set, mapped to the 1–4 hotkeys in triage mode. */
export const TRIAGE_VERDICTS = ['hack', 'clean', 'interesting', 'unsure'] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

export const ANNOTATOR_STORAGE_KEY = 'rollout_viz_annotator';

export function loadAnnotator(): string {
  try {
    return localStorage.getItem(ANNOTATOR_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAnnotator(name: string): void {
  try {
    localStorage.setItem(ANNOTATOR_STORAGE_KEY, name);
  } catch { /* ignore */ }
}

export function isHumanEntry(entry: GradeEntry): boolean {
  return entry.model.startsWith('human:') || entry.model === 'human';
}

/** "human:ada" → "ada". A non-human model string shows as-is. */
export function authorOf(model: string): string {
  return model.startsWith('human:') ? model.slice('human:'.length) : model;
}

export function latestEntry(list: GradeEntry[] | undefined): GradeEntry | undefined {
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/** Latest human-authored entry for a metric, regardless of later judge runs. */
export function latestHumanEntry(list: GradeEntry[] | undefined): GradeEntry | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isHumanEntry(list[i])) return list[i];
  }
  return undefined;
}

/** Latest judge (non-human) entry for a metric. */
export function latestJudgeEntry(list: GradeEntry[] | undefined): GradeEntry | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isHumanEntry(list[i])) return list[i];
  }
  return undefined;
}

export function buildHumanEntry(options: {
  grade: string | number | boolean;
  gradeType: GradeType;
  annotator: string;
  note?: string;
  promptVersion?: string;
}): GradeEntry {
  return {
    grade: options.grade,
    grade_type: options.gradeType,
    quotes: [],
    explanation: options.note ?? '',
    model: `human:${options.annotator || 'anonymous'}`,
    prompt_version: options.promptVersion ?? 'triage-v1',
    timestamp: new Date().toISOString(),
  };
}

// ── Comment soft-delete (tombstones) ────────────────────────────────────────
//
// The save merge is append-only by design (nothing is ever rewritten in the
// log), so "delete this comment" is expressed as one MORE entry in the same
// list: a tombstone that names its target by (model, timestamp). Readers hide
// both the tombstone and everything it targets; the raw JSONL keeps the whole
// history, including who deleted what and when.

/**
 * Textual identity of a comment for tombstone matching. JSON keeps the two
 * parts unambiguous (a model string may contain any character) and the
 * source free of control-byte separators.
 */
const commentKey = (model: string, timestamp: string): string => JSON.stringify([model, timestamp]);

/** True for a deletion record rather than a comment. */
export function isCommentTombstone(entry: GradeEntry): boolean {
  return entry.prompt_version === COMMENT_DELETE_PROMPT_VERSION || entry.deletes !== undefined;
}

/**
 * The one true reader of a `comments` list: the entries a human should see.
 * Drops tombstones themselves, plus every entry a tombstone targets.
 *
 * Targeting is exact (model, timestamp) string equality. Two comments written
 * with the SAME author and the SAME timestamp (possible via direct API writes;
 * the UI can't produce it) are indistinguishable, so one tombstone hides both.
 * A tombstone whose target isn't in the list is inert.
 */
export function visibleComments(list: GradeEntry[] | undefined): GradeEntry[] {
  if (!list || list.length === 0) return [];
  const tombstones = list.filter(isCommentTombstone);
  if (tombstones.length === 0) return list;
  const deleted = new Set<string>();
  for (const t of tombstones) {
    if (t.deletes) deleted.add(commentKey(t.deletes.model, t.deletes.timestamp));
  }
  return list.filter(
    entry => !isCommentTombstone(entry) && !deleted.has(commentKey(entry.model, entry.timestamp)),
  );
}

/** A signed deletion record for `target`, appended to the same metric list. */
export function buildCommentTombstone(target: GradeEntry, annotator: string): GradeEntry {
  return {
    grade: '',
    grade_type: 'freeform',
    quotes: [],
    explanation: `deleted comment by ${target.model} from ${target.timestamp}`,
    model: `human:${annotator || 'anonymous'}`,
    prompt_version: COMMENT_DELETE_PROMPT_VERSION,
    timestamp: new Date().toISOString(),
    deletes: { model: target.model, timestamp: target.timestamp },
  };
}

/**
 * Reconcile a sample's grade lists with a freshly fetched copy. Grade lists
 * are append-only, so for each metric the LONGER list is the newer one —
 * this keeps a tombstone or comment appended locally from being clobbered by
 * a hydration response whose snapshot predates the append. Two writers
 * appending concurrently (equal lengths, different tails) can't be merged
 * here; the server copy wins and the next full load converges.
 */
export function mergeAppendOnlyGrades(
  local: SampleGrades | undefined,
  fetched: SampleGrades | undefined,
): SampleGrades | undefined {
  if (!local) return fetched;
  if (!fetched) return local;
  const merged: SampleGrades = { ...fetched };
  for (const [metric, list] of Object.entries(local)) {
    const fetchedList = merged[metric];
    if (!fetchedList || list.length > fetchedList.length) merged[metric] = list;
  }
  return merged;
}

/**
 * The (source file, index-within-file) pair the save endpoint keys on.
 * Mirrors the mapping App uses for grading jobs: batch loading assigns
 * sequential global ids, but each file's samples keep their in-file order.
 */
export function fileLocationOf(
  sample: Sample,
  allSamples: Sample[],
  fallbackFile: string,
): { filePath: string; indexInFile: number } | null {
  const filePath = sample.attributes.source_file || fallbackFile;
  if (!filePath) return null;
  const sameFile = allSamples.filter(
    s => (s.attributes.source_file || fallbackFile) === filePath,
  );
  const indexInFile = sameFile.findIndex(s => s.id === sample.id);
  return indexInFile >= 0 ? { filePath, indexInFile } : null;
}

/** Persist one human grade entry through the existing append-only merge. */
export async function saveHumanGrade(
  filePath: string,
  indexInFile: number,
  metric: string,
  entry: GradeEntry,
): Promise<boolean> {
  try {
    const res = await fetch('/api/save-graded', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: filePath,
        grades: { [indexInFile]: { [metric]: entry } },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
