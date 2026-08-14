// Evidence-first navigation over grader quotes.
//
// The Evidence view inverts the usual rollout-first flow: instead of opening
// one sample and inspecting its grades, it flattens EVERY quote the LLM judge
// saved for one metric across the loaded corpus into a single feed, with
// audit flags for entries whose "evidence" can't actually be found in the
// transcript (a strong hallucination signal).
//
// Pure functions only — the EvidenceView component is entirely props-driven
// and all corpus logic lives here so it can be unit-tested without React.

import type { GradeEntry, Quote, Sample } from '../types';
import { latestJudgeEntry } from './humanGrades';
import { findAllMatchesCI } from './textMatch';
import { buildSearchCorpus } from './parseContent';

export interface EvidenceItem {
  sampleId: number;
  rolloutN: number | string;
  sourceFile: string; // sample.attributes.source_file || ''
  reward: number;
  /** The LATEST JUDGE entry for the metric (human audits never selected). */
  entry: GradeEntry;
  /** null => the entry saved no quotes. */
  quote: Quote | null;
  context: { before: string; match: string; after: string } | null;
  // Flags:
  /** Entry has zero quotes. */
  noEvidence: boolean;
  /** Quote text absent from the referenced message (possible hallucinated evidence). */
  quoteNotFound: boolean;
  /** Messages empty (metadata-only load) — can't verify yet. */
  transcriptUnloaded: boolean;
}

/** Characters of context kept on each side of a located quote. */
const CONTEXT_CHARS = 160;

// Drop a leading partial word (everything up to the first whitespace) so a
// hard character cut still starts at a word boundary.
function trimToWordStart(s: string): string {
  const ws = s.search(/\s/);
  return ws === -1 ? s : s.slice(ws).replace(/^\s+/, '');
}

// Drop a trailing partial word (everything after the last whitespace).
function trimToWordEnd(s: string): string {
  for (let i = s.length - 1; i >= 0; i--) {
    if (/\s/.test(s[i])) return s.slice(0, i + 1).replace(/\s+$/, '');
  }
  return s;
}

// ±CONTEXT_CHARS of surrounding text, trimmed to word boundaries with an
// ellipsis marking each truncated side. `match` slices the ORIGINAL content
// (findAllMatchesCI reports offsets valid in the un-normalized string).
function buildContext(
  content: string,
  start: number,
  end: number,
): { before: string; match: string; after: string } {
  const beforeStart = start - CONTEXT_CHARS;
  const beforeRaw = content.slice(Math.max(0, beforeStart), start);
  const before = beforeStart > 0 ? '…' + trimToWordStart(beforeRaw) : beforeRaw;

  const afterEnd = end + CONTEXT_CHARS;
  const afterRaw = content.slice(end, Math.min(content.length, afterEnd));
  const after = afterEnd < content.length ? trimToWordEnd(afterRaw) + '…' : afterRaw;

  return { before, match: content.slice(start, end), after };
}

/**
 * Metrics that have at least one JUDGE grade anywhere in the corpus, with how
 * many samples carry one (`gradedCount`) and the total quotes across those
 * latest judge entries (`quoteCount`). Sorted by metric name. Metrics whose
 * only entries are human audits are excluded — there's no judge evidence to
 * browse.
 */
export function metricsWithGrades(
  samples: Sample[],
): { metric: string; gradedCount: number; quoteCount: number }[] {
  const acc = new Map<string, { gradedCount: number; quoteCount: number }>();
  for (const sample of samples) {
    for (const [metric, list] of Object.entries(sample.grades ?? {})) {
      const entry = latestJudgeEntry(list);
      if (!entry) continue;
      const counts = acc.get(metric) ?? { gradedCount: 0, quoteCount: 0 };
      counts.gradedCount += 1;
      counts.quoteCount += entry.quotes?.length ?? 0;
      acc.set(metric, counts);
    }
  }
  return [...acc.entries()]
    .map(([metric, counts]) => ({ metric, ...counts }))
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

// Sort rank: flagged items surface first so audits start with the suspicious
// entries. `transcriptUnloaded` is informational, not suspicious — it sorts
// with the clean items.
function flagRank(item: EvidenceItem): number {
  if (item.noEvidence) return 0;
  if (item.quoteNotFound) return 1;
  return 2;
}

function compareRollout(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Flatten every quote of the latest judge entry for `metric` into one
 * EvidenceItem per quote (entries without quotes yield a single flagged
 * item). Samples with no judge entry for the metric are skipped entirely.
 *
 * Order: flagged first (noEvidence, then quoteNotFound), then by
 * (sourceFile, rolloutN, quote.message_index, quote.start).
 */
export function buildEvidenceIndex(samples: Sample[], metric: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const sample of samples) {
    const entry = latestJudgeEntry(sample.grades?.[metric]);
    if (!entry) continue;
    const base = {
      sampleId: sample.id,
      rolloutN: sample.attributes.rollout_n,
      sourceFile: sample.attributes.source_file || '',
      reward: sample.attributes.reward,
      entry,
    };
    const transcriptUnloaded = sample.messages.length === 0;
    const quotes = entry.quotes ?? [];

    if (quotes.length === 0) {
      items.push({
        ...base,
        quote: null,
        context: null,
        noEvidence: true,
        quoteNotFound: false,
        transcriptUnloaded,
      });
      continue;
    }

    for (const quote of quotes) {
      if (transcriptUnloaded) {
        items.push({
          ...base,
          quote,
          context: null,
          noEvidence: false,
          quoteNotFound: false,
          transcriptUnloaded: true,
        });
        continue;
      }
      // A quote pointing at a message index that doesn't exist is treated the
      // same as text missing from an existing message: not found.
      //
      // The haystack is the RENDERED corpus of the message, not the raw
      // `content` field — reasoning and tool calls often live in
      // `content_parts`/`tool_calls` (raw content is empty), and quotes with
      // channel=thinking/tool_call would be falsely flagged as fabricated.
      const message = sample.messages[quote.message_index];
      const content = message ? buildSearchCorpus(message) : '';
      const matches = content ? findAllMatchesCI(content, quote.text) : [];
      if (matches.length === 0) {
        items.push({
          ...base,
          quote,
          context: null,
          noEvidence: false,
          quoteNotFound: true,
          transcriptUnloaded: false,
        });
      } else {
        const first = matches[0];
        items.push({
          ...base,
          quote,
          context: buildContext(content, first.start, first.end),
          noEvidence: false,
          quoteNotFound: false,
          transcriptUnloaded: false,
        });
      }
    }
  }

  items.sort(
    (a, b) =>
      flagRank(a) - flagRank(b) ||
      a.sourceFile.localeCompare(b.sourceFile) ||
      compareRollout(a.rolloutN, b.rolloutN) ||
      (a.quote?.message_index ?? -1) - (b.quote?.message_index ?? -1) ||
      (a.quote?.start ?? -1) - (b.quote?.start ?? -1),
  );
  return items;
}

/**
 * Stable identity for an item across filter changes — used by EvidenceView
 * both as the React key and as the key of its optimistic "recorded" set.
 */
export function evidenceItemKey(item: EvidenceItem): string {
  return item.quote
    ? `${item.sampleId}:${item.quote.message_index}:${item.quote.start}`
    : `${item.sampleId}:none`;
}
