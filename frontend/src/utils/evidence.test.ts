import { describe, it, expect } from 'vitest';
import type { GradeEntry, Quote, Sample } from '../types';
import { makeSample, makeMessage } from '../test/fixtures';
import {
  buildEvidenceIndex,
  evidenceItemKey,
  metricsWithGrades,
} from './evidence';

function makeEntry(overrides: Partial<GradeEntry> = {}): GradeEntry {
  return {
    grade: true,
    grade_type: 'bool',
    quotes: [],
    explanation: 'because',
    model: 'gpt-4o',
    prompt_version: 'v1',
    timestamp: '2026-01-15T10:00:00',
    ...overrides,
  };
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return { message_index: 1, start: 0, end: 10, text: 'quoted', ...overrides };
}

// A sample whose assistant message (index 1) has `content`, graded on `metric`.
function gradedSample(
  id: number,
  metric: string,
  entries: GradeEntry[],
  options: {
    content?: string;
    rolloutN?: number;
    sourceFile?: string;
    reward?: number;
    messages?: Sample['messages'];
  } = {},
): Sample {
  return makeSample({
    id,
    messages:
      options.messages ??
      [makeMessage('user', 'hi'), makeMessage('assistant', options.content ?? 'hello world')],
    attributes: {
      rollout_n: options.rolloutN ?? id,
      source_file: options.sourceFile ?? '/data/run/a.jsonl',
      reward: options.reward ?? 0.5,
    },
    grades: { [metric]: entries },
  });
}

describe('metricsWithGrades', () => {
  it('counts graded samples and quotes per metric, sorted by name', () => {
    const samples = [
      gradedSample(1, 'zeta', [makeEntry({ quotes: [makeQuote(), makeQuote({ start: 3 })] })]),
      gradedSample(2, 'zeta', [makeEntry()]),
      gradedSample(3, 'alpha', [makeEntry({ quotes: [makeQuote()] })]),
    ];
    expect(metricsWithGrades(samples)).toEqual([
      { metric: 'alpha', gradedCount: 1, quoteCount: 1 },
      { metric: 'zeta', gradedCount: 2, quoteCount: 2 },
    ]);
  });

  it('excludes metrics whose only entries are human audits', () => {
    const samples = [
      gradedSample(1, 'human_only', [makeEntry({ model: 'human:alice' })]),
    ];
    expect(metricsWithGrades(samples)).toEqual([]);
  });

  it('counts quotes from the latest JUDGE entry even when a human entry is newer', () => {
    const samples = [
      gradedSample(1, 'hack', [
        makeEntry({ quotes: [makeQuote()] }),
        makeEntry({ model: 'human:alice', quotes: [] }),
      ]),
    ];
    expect(metricsWithGrades(samples)).toEqual([
      { metric: 'hack', gradedCount: 1, quoteCount: 1 },
    ]);
  });

  it('returns [] when no sample has grades', () => {
    expect(metricsWithGrades([makeSample({ id: 1 })])).toEqual([]);
  });
});

describe('buildEvidenceIndex', () => {
  it('locates a quote and returns ±160 chars of word-boundary-trimmed context', () => {
    const before = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const after = Array.from({ length: 60 }, (_, i) => `tail${i}`).join(' ');
    const content = `${before} THE QUOTED SPAN ${after}`;
    const start = content.indexOf('THE QUOTED SPAN');
    const quote = makeQuote({ start, end: start + 15, text: 'THE QUOTED SPAN' });

    const [item] = buildEvidenceIndex(
      [gradedSample(1, 'hack', [makeEntry({ quotes: [quote] })], { content })],
      'hack',
    );

    expect(item.noEvidence).toBe(false);
    expect(item.quoteNotFound).toBe(false);
    expect(item.transcriptUnloaded).toBe(false);
    expect(item.quote).toEqual(quote);
    expect(item.context).not.toBeNull();
    const ctx = item.context!;
    expect(ctx.match).toBe('THE QUOTED SPAN');
    // Both sides truncated -> ellipses.
    expect(ctx.before.startsWith('…')).toBe(true);
    expect(ctx.after.endsWith('…')).toBe(true);
    // Trimmed to word boundaries: everything between the ellipses is a
    // verbatim slice of the original content starting/ending on whole words.
    const reconstructed = ctx.before.slice(1) + ctx.match + ctx.after.slice(0, -1);
    expect(content).toContain(reconstructed);
    const firstWord = ctx.before.slice(1).trim().split(/\s+/)[0];
    expect(before.split(' ')).toContain(firstWord);
    const lastWord = ctx.after.slice(0, -1).trim().split(/\s+/).pop();
    expect(after.split(' ')).toContain(lastWord);
    // Bounded by the context budget (plus the ellipsis characters).
    expect(ctx.before.length).toBeLessThanOrEqual(161);
    expect(ctx.after.length).toBeLessThanOrEqual(161);
  });

  it('keeps full untruncated context (no ellipses) for short messages', () => {
    const content = 'prefix THE SPAN suffix';
    const quote = makeQuote({ text: 'THE SPAN' });
    const [item] = buildEvidenceIndex(
      [gradedSample(1, 'hack', [makeEntry({ quotes: [quote] })], { content })],
      'hack',
    );
    expect(item.context).toEqual({ before: 'prefix ', match: 'THE SPAN', after: ' suffix' });
  });

  it('matches case-insensitively and across normalized whitespace', () => {
    // U+202F narrow no-break space in the transcript, plain space in the quote.
    const content = 'meeting at 7\u202Fam tomorrow';
    const quote = makeQuote({ text: 'AT 7 AM' });
    const [item] = buildEvidenceIndex(
      [gradedSample(1, 'hack', [makeEntry({ quotes: [quote] })], { content })],
      'hack',
    );
    expect(item.quoteNotFound).toBe(false);
    // The match slices the ORIGINAL content, preserving its codepoints.
    expect(item.context?.match).toBe('at 7\u202Fam');
  });

  it('flags quoteNotFound with null context when the text is absent', () => {
    const quote = makeQuote({ text: 'never said this' });
    const [item] = buildEvidenceIndex(
      [gradedSample(1, 'hack', [makeEntry({ quotes: [quote] })], { content: 'hello world' })],
      'hack',
    );
    expect(item.quoteNotFound).toBe(true);
    expect(item.context).toBeNull();
    expect(item.noEvidence).toBe(false);
    expect(item.transcriptUnloaded).toBe(false);
    expect(item.quote).toEqual(quote);
  });

  it('flags quoteNotFound when the quote references a nonexistent message', () => {
    const quote = makeQuote({ message_index: 99, text: 'hello' });
    const [item] = buildEvidenceIndex(
      [gradedSample(1, 'hack', [makeEntry({ quotes: [quote] })], { content: 'hello world' })],
      'hack',
    );
    expect(item.quoteNotFound).toBe(true);
    expect(item.context).toBeNull();
  });

  it('flags noEvidence with quote=null when the entry saved no quotes', () => {
    const items = buildEvidenceIndex(
      [gradedSample(1, 'hack', [makeEntry({ quotes: [] })])],
      'hack',
    );
    expect(items).toHaveLength(1);
    expect(items[0].noEvidence).toBe(true);
    expect(items[0].quote).toBeNull();
    expect(items[0].context).toBeNull();
    expect(items[0].quoteNotFound).toBe(false);
  });

  it('flags transcriptUnloaded (not quoteNotFound) for metadata-only samples', () => {
    const quote = makeQuote({ text: 'anything' });
    const [item] = buildEvidenceIndex(
      [gradedSample(1, 'hack', [makeEntry({ quotes: [quote] })], { messages: [] })],
      'hack',
    );
    expect(item.transcriptUnloaded).toBe(true);
    expect(item.quoteNotFound).toBe(false);
    expect(item.noEvidence).toBe(false);
    expect(item.context).toBeNull();
    expect(item.quote).toEqual(quote);
  });

  it('fans out one item per quote and carries sample attributes', () => {
    const content = 'aaa bbb ccc';
    const quotes = [
      makeQuote({ text: 'aaa', start: 0, end: 3 }),
      makeQuote({ text: 'bbb', start: 4, end: 7 }),
      makeQuote({ text: 'ccc', start: 8, end: 11 }),
    ];
    const items = buildEvidenceIndex(
      [gradedSample(7, 'hack', [makeEntry({ quotes })], {
        content,
        rolloutN: 42,
        sourceFile: '/x/y.jsonl',
        reward: -1.5,
      })],
      'hack',
    );
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.sampleId).toBe(7);
      expect(item.rolloutN).toBe(42);
      expect(item.sourceFile).toBe('/x/y.jsonl');
      expect(item.reward).toBe(-1.5);
    }
    expect(items.map(i => i.context?.match)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('uses the latest JUDGE entry, excluding newer human audit entries', () => {
    const content = 'the model hacked the test';
    const judge = makeEntry({ grade: false, quotes: [makeQuote({ text: 'hacked' })] });
    const human = makeEntry({ model: 'human:alice', grade: true, quotes: [] });
    const items = buildEvidenceIndex(
      [gradedSample(1, 'hack', [judge, human], { content })],
      'hack',
    );
    expect(items).toHaveLength(1);
    expect(items[0].entry).toBe(judge);
    expect(items[0].noEvidence).toBe(false);
  });

  it('skips samples with no judge entry for the metric', () => {
    const humanOnly = gradedSample(1, 'hack', [makeEntry({ model: 'human:bob' })]);
    const ungraded = makeSample({ id: 2 });
    const otherMetric = gradedSample(3, 'other', [makeEntry()]);
    expect(buildEvidenceIndex([humanOnly, ungraded, otherMetric], 'hack')).toEqual([]);
  });

  it('orders flagged items first, then by (sourceFile, rolloutN, message_index, start)', () => {
    const content = 'aaa bbb ccc';
    const q = (start: number, text: string, message_index = 1) =>
      makeQuote({ start, end: start + 3, text, message_index });

    const clean1 = gradedSample(
      10,
      'hack',
      // Two quotes deliberately out of order in the entry.
      [makeEntry({ quotes: [q(8, 'ccc'), q(0, 'aaa')] })],
      { content, sourceFile: '/data/b.jsonl', rolloutN: 2 },
    );
    const clean2 = gradedSample(11, 'hack', [makeEntry({ quotes: [q(4, 'bbb')] })], {
      content,
      sourceFile: '/data/a.jsonl',
      rolloutN: 9,
    });
    const notFound = gradedSample(12, 'hack', [makeEntry({ quotes: [q(0, 'zzz')] })], {
      content,
      sourceFile: '/data/a.jsonl',
      rolloutN: 1,
    });
    const noQuotes = gradedSample(13, 'hack', [makeEntry({ quotes: [] })], {
      sourceFile: '/data/z.jsonl',
      rolloutN: 1,
    });

    const items = buildEvidenceIndex([clean1, clean2, notFound, noQuotes], 'hack');
    expect(
      items.map(i => ({ id: i.sampleId, start: i.quote?.start ?? null })),
    ).toEqual([
      { id: 13, start: null }, // noEvidence first
      { id: 12, start: 0 }, // then quoteNotFound
      { id: 11, start: 4 }, // then clean: a.jsonl before b.jsonl
      { id: 10, start: 0 }, // b.jsonl, quotes ordered by start
      { id: 10, start: 8 },
    ]);
  });
});

describe('rendered-corpus quote location', () => {
  it('locates thinking-channel quotes that live in content_parts (raw content empty)', () => {
    // Regression: quotes on reasoning extracted from content_parts were
    // falsely flagged quoteNotFound because the locator searched only the
    // raw (empty) `content` field instead of the rendered corpus.
    const sample = gradedSample(1, 'thinks_grader_not_real', [
      makeEntry({
        quotes: [makeQuote({ message_index: 1, channel: 'thinking', text: 'the grader is simulated' })],
      }),
    ], {
      messages: [
        makeMessage({ role: 'user', content: 'solve it' }),
        {
          role: 'assistant',
          content: '',
          content_parts: [
            { type: 'thinking', thinking: 'I suspect the grader is simulated and not real.' },
            { type: 'text', text: 'Done.' },
          ],
        },
      ],
    });
    const items = buildEvidenceIndex([sample], 'thinks_grader_not_real');
    expect(items).toHaveLength(1);
    expect(items[0].quoteNotFound).toBe(false);
    expect(items[0].context?.match.toLowerCase()).toBe('the grader is simulated');
  });

  it('matches quotes case-insensitively against the transcript', () => {
    const sample = gradedSample(1, 'm', [
      makeEntry({ quotes: [makeQuote({ text: 'The final grade is decided' })] }),
    ], { content: 'but the final grade is decided by the monitor.' });
    const items = buildEvidenceIndex([sample], 'm');
    expect(items[0].quoteNotFound).toBe(false);
    expect(items[0].context?.match).toBe('the final grade is decided');
  });
});

describe('evidenceItemKey', () => {
  it('is stable and distinct per quote, with a dedicated no-quote key', () => {
    const content = 'aaa bbb';
    const quotes = [
      makeQuote({ text: 'aaa', start: 0, end: 3 }),
      makeQuote({ text: 'bbb', start: 4, end: 7 }),
    ];
    const [a, b] = buildEvidenceIndex(
      [gradedSample(5, 'hack', [makeEntry({ quotes })], { content })],
      'hack',
    );
    expect(evidenceItemKey(a)).not.toBe(evidenceItemKey(b));
    const [none] = buildEvidenceIndex(
      [gradedSample(5, 'hack', [makeEntry({ quotes: [] })])],
      'hack',
    );
    expect(evidenceItemKey(none)).toBe('5:none');
  });
});
