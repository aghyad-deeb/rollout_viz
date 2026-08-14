import { describe, it, expect } from 'vitest';
import {
  mean,
  median,
  std,
  computeRewardStats,
  computeNumericStats,
  buildRewardHistogram,
  buildNumericHistogram,
  buildStepSeries,
  buildNumericStepSeries,
  buildSourceBreakdown,
  buildNumericSourceBreakdown,
  disambiguateLabels,
  coveredFraction,
  buildGradeSummary,
  describeMetrics,
  buildCategoryBreakdown,
  buildCategoryByStep,
  buildBoolRateByStep,
  buildBoolRateBySource,
  computeBoolRate,
  isAxisField,
} from './analysisData';
import { makeSample, makeGradeEntry } from '../../test/fixtures';
import type { Sample } from '../../types';

// Helper: a sample with a given reward / data_source / step.
const s = (reward: number, data_source = 'a/b/c', step = 0): Sample =>
  makeSample({ attributes: { reward, data_source, step } as Sample['attributes'] });

describe('basic statistics', () => {
  it('mean / median / std', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3); // sorts internally
    expect(std([2, 2, 2])).toBe(0);
    expect(std([1])).toBe(0); // n<2 guard
  });

  it('empty arrays are safe', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(std([])).toBe(0);
  });
});

describe('computeRewardStats', () => {
  it('reports median and floor share on floor-saturated data', () => {
    // 8 at the -5 floor, 2 positive — mean is misleading, median is the floor
    const samples = [
      ...Array.from({ length: 8 }, () => s(-5)),
      s(3),
      s(7),
    ];
    const stats = computeRewardStats(samples);
    expect(stats.n).toBe(10);
    expect(stats.min).toBe(-5);
    expect(stats.max).toBe(7);
    expect(stats.median).toBe(-5); // robust to the floor pile-up
    expect(stats.floorValue).toBe(-5);
    expect(stats.floorCount).toBe(8);
    expect(stats.floorPct).toBeCloseTo(0.8);
    expect(stats.negativeCount).toBe(8);
    expect(stats.negativePct).toBeCloseTo(0.8);
    expect(stats.mean).toBeCloseTo((-5 * 8 + 3 + 7) / 10);
  });

  it('handles no valid rewards', () => {
    const stats = computeRewardStats([]);
    expect(stats.n).toBe(0);
    expect(stats.mean).toBe(0);
  });
});

describe('buildRewardHistogram', () => {
  it('bins rewards and computes percentages', () => {
    const samples = [s(0), s(0), s(5), s(10)];
    const bins = buildRewardHistogram(samples, 2);
    expect(bins).toHaveLength(2);
    // total count preserved
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(4);
    // percentages sum to 1
    expect(bins.reduce((a, b) => a + b.pct, 0)).toBeCloseTo(1);
  });

  it('collapses to a single bin when all rewards are equal', () => {
    const bins = buildRewardHistogram([s(-5), s(-5), s(-5)], 20);
    expect(bins).toHaveLength(1);
    expect(bins[0].count).toBe(3);
    expect(bins[0].isNegative).toBe(true);
  });

  it('flags negative bins for coloring', () => {
    const bins = buildRewardHistogram([s(-10), s(10)], 2);
    expect(bins[0].isNegative).toBe(true);
    expect(bins[bins.length - 1].isNegative).toBe(false);
  });

  it('never renders a "-0.0" edge label', () => {
    // A tiny-negative left edge used to fix-format as "-0.0".
    const bins = buildRewardHistogram([s(-0.04), s(0.16)], 20);
    expect(bins.length).toBeGreaterThan(1);
    for (const b of bins) expect(b.label).not.toMatch(/^-0\.0/);
    expect(bins[0].label).toBe('0.0');

    // Single-bin branch (constant value) formats with 2 decimals — "-0.00" before.
    const single = buildRewardHistogram([s(-0.001), s(-0.001)], 20);
    expect(single).toHaveLength(1);
    expect(single[0].label).not.toMatch(/^-0\.0/);
    expect(single[0].label).toBe('0.00');
  });

  it('keeps genuinely negative edge labels signed', () => {
    const bins = buildRewardHistogram([s(-5), s(5)], 2);
    expect(bins[0].label).toBe('-5.0');
  });
});

describe('buildStepSeries', () => {
  it('aggregates reward per step with spread and n', () => {
    const samples = [
      s(0, 'x', 1), s(10, 'x', 1), // step 1: mean 5, n 2
      s(4, 'x', 2), // step 2
    ];
    const series = buildStepSeries(samples);
    expect(series.map(p => p.step)).toEqual([1, 2]); // sorted
    expect(series[0].mean).toBe(5);
    expect(series[0].min).toBe(0);
    expect(series[0].max).toBe(10);
    expect(series[0].n).toBe(2);
    expect(series[0].std).toBeGreaterThan(0);
    expect(series[1].n).toBe(1);
  });
});

describe('disambiguateLabels', () => {
  it('uses the leaf when leaves are unique', () => {
    const m = disambiguateLabels(['a/b/foo', 'a/b/bar']);
    expect(m.get('a/b/foo')).toBe('foo');
    expect(m.get('a/b/bar')).toBe('bar');
  });

  it('extends the suffix to avoid collisions between distinct paths', () => {
    // Both end in "reward_check" — must not collapse to the same label
    const m = disambiguateLabels(['coding/x/reward_check', 'math/y/reward_check']);
    expect(m.get('coding/x/reward_check')).not.toBe(m.get('math/y/reward_check'));
    expect(m.get('coding/x/reward_check')).toBe('x/reward_check');
    expect(m.get('math/y/reward_check')).toBe('y/reward_check');
  });
});

describe('buildSourceBreakdown', () => {
  it('groups by FULL path (no leaf collisions) with counts and robust reward', () => {
    const samples = [
      s(-5, 'coding/x/reward_check'),
      s(10, 'coding/x/reward_check'),
      s(-5, 'math/y/reward_check'),
    ];
    const rows = buildSourceBreakdown(samples);
    expect(rows).toHaveLength(2); // distinct full paths, not merged by leaf
    const coding = rows.find(r => r.fullName === 'coding/x/reward_check')!;
    expect(coding.count).toBe(2);
    expect(coding.median).toBe(2.5);
    expect(coding.floorPct).toBeCloseTo(0.5); // one of two at the global floor (-5)
    expect(rows[0].count).toBeGreaterThanOrEqual(rows[1].count); // sorted desc by count
  });

  it('coveredFraction reports the share captured by the top rows', () => {
    const samples = [
      ...Array.from({ length: 7 }, () => s(0, 'big')),
      ...Array.from({ length: 3 }, () => s(0, 'small')),
    ];
    const rows = buildSourceBreakdown(samples);
    expect(coveredFraction(rows, 1)).toBeCloseTo(0.7);
    expect(coveredFraction(rows, 2)).toBeCloseTo(1);
  });
});

describe('buildGradeSummary', () => {
  it('summarizes boolean metrics as a true-rate using the latest entry', () => {
    const samples = [
      makeSample({ grades: { safety: [makeGradeEntry(true, 'bool')] } } as Partial<Sample>),
      makeSample({ grades: { safety: [makeGradeEntry(false, 'bool')] } } as Partial<Sample>),
      makeSample({ grades: { safety: [makeGradeEntry(true, 'bool')] } } as Partial<Sample>),
    ];
    const summary = buildGradeSummary(samples);
    expect(summary).toHaveLength(1);
    expect(summary[0].metric).toBe('safety');
    expect(summary[0].isBool).toBe(true);
    expect(summary[0].n).toBe(3);
    expect(summary[0].trueRate).toBeCloseTo(2 / 3);
  });

  it('summarizes numeric metrics with mean/min/max', () => {
    const samples = [
      makeSample({ grades: { quality: [makeGradeEntry(0.2, 'float')] } } as Partial<Sample>),
      makeSample({ grades: { quality: [makeGradeEntry(0.8, 'float')] } } as Partial<Sample>),
    ];
    const summary = buildGradeSummary(samples);
    expect(summary[0].isNumeric).toBe(true);
    expect(summary[0].mean).toBeCloseTo(0.5);
    expect(summary[0].min).toBe(0.2);
    expect(summary[0].max).toBe(0.8);
  });

  it('returns nothing when there are no grades', () => {
    expect(buildGradeSummary([makeSample()])).toEqual([]);
  });

  it('excludes the reserved comments metric (a human note, not a judgement)', () => {
    const comment = {
      grade: 'looks like a reward hack',
      grade_type: 'freeform' as const,
      quotes: [],
      explanation: '',
      model: 'human:ada',
      prompt_version: 'comment-v1',
      timestamp: '2026-01-15T10:00:00',
    };
    const samples = [
      makeSample({ grades: { comments: [comment], safety: [makeGradeEntry(true, 'bool')] } } as Partial<Sample>),
    ];
    expect(buildGradeSummary(samples).map(g => g.metric)).toEqual(['safety']);
    // …so it never reaches the inspector's metric picker either.
    expect(describeMetrics(samples).some(d => d.source === 'grade' && d.key === 'comments')).toBe(false);
  });
});

// ---- Feature 2: generic non-reward metrics --------------------------------

// Build a sample with arbitrary extra attribute keys (attributes is narrow-typed).
const sx = (attrs: Record<string, unknown>): Sample =>
  makeSample({ attributes: { ...{ reward: 0, data_source: 'a/b', step: 0 }, ...attrs } as Sample['attributes'] });

describe('generic numeric builders are parity-equal to the reward builders', () => {
  const samples = [s(-5), s(3), s(7), s(-5, 'x/y', 1)];
  it('histogram / step / source / stats match for key=reward', () => {
    expect(buildNumericHistogram(samples, 'reward')).toEqual(buildRewardHistogram(samples));
    expect(buildNumericStepSeries(samples, 'reward')).toEqual(buildStepSeries(samples));
    expect(buildNumericSourceBreakdown(samples, 'reward')).toEqual(buildSourceBreakdown(samples));
    expect(computeNumericStats(samples, 'reward')).toEqual(computeRewardStats(samples));
  });

  it('numeric builders work on a non-reward key', () => {
    const ss = [sx({ score_num: 1 }), sx({ score_num: 9 }), sx({ score_num: 5 })];
    const stats = computeNumericStats(ss, 'score_num');
    expect(stats.n).toBe(3);
    expect(stats.median).toBe(5);
    expect(stats.max).toBe(9);
  });
});

describe('describeMetrics classification', () => {
  it('classifies numeric, categorical, boolean, id, and grade metrics', () => {
    const samples = Array.from({ length: 12 }, (_, i) =>
      sx({
        reward: i,                         // numeric
        score_value: i % 2 ? 'C' : 'I',    // categorical (2 distinct)
        lossless_replay: i % 2 === 0,      // boolean
        run_id: `run_${i}`,                // id (unique per sample)
        step: i,                           // numeric axis → hidden (id)
      }),
    );
    samples[0] = makeSample({
      attributes: { reward: 0, data_source: 'a/b', step: 0, score_value: 'C', lossless_replay: true, run_id: 'run_0' } as Sample['attributes'],
      grades: { reward_hack: [makeGradeEntry(true, 'bool')] },
    } as Partial<Sample>);

    const byKey = Object.fromEntries(describeMetrics(samples).map(m => [`${m.source}:${m.key}`, m]));
    expect(byKey['attribute:reward'].kind).toBe('numeric');
    expect(byKey['attribute:score_value'].kind).toBe('categorical');
    expect(byKey['attribute:lossless_replay'].kind).toBe('boolean');
    expect(byKey['attribute:run_id'].kind).toBe('id');     // high-cardinality
    expect(byKey['attribute:step'].kind).toBe('id');       // numeric grouping axis, hidden
    expect(byKey['grade:reward_hack'].kind).toBe('boolean');
  });

  it('drops empty fields', () => {
    const ss = [sx({ blank: '' }), sx({ blank: null })];
    expect(describeMetrics(ss).find(m => m.key === 'blank')?.kind).toBe('empty');
  });

  it('isAxisField flags numeric grouping axes and nothing else', () => {
    expect(isAxisField('step')).toBe(true);
    expect(isAxisField('rollout_n')).toBe(true);
    expect(isAxisField('sample_index')).toBe(true);
    expect(isAxisField('reward')).toBe(false);
    expect(isAxisField('run_id')).toBe(false); // an id, but not an axis
  });
});

describe('categorical builders', () => {
  const samples = [
    sx({ score_value: 'C', step: 0 }),
    sx({ score_value: 'C', step: 0 }),
    sx({ score_value: 'I', step: 0 }),
    sx({ score_value: 'I', step: 1 }),
  ];
  it('buildCategoryBreakdown counts + pct sum to 1, sorted desc', () => {
    const rows = buildCategoryBreakdown(samples, 'score_value');
    expect(rows[0]).toMatchObject({ value: 'C', count: 2 });
    expect(rows.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(1);
    expect(rows[0].count).toBeGreaterThanOrEqual(rows[1].count);
  });
  it('buildCategoryByStep composition per step sums to that step n', () => {
    const byStep = buildCategoryByStep(samples, 'score_value');
    const step0 = byStep.find(r => r.step === 0)!;
    expect(step0.n).toBe(3);
    expect(step0.counts.C + step0.counts.I).toBe(3);
  });
});

describe('boolean / grade rate builders', () => {
  const samples = [
    sx({ flag: true, step: 0 }),
    sx({ flag: false, step: 0 }),
    sx({ flag: true, step: 1 }),
  ];
  it('computeBoolRate and by-step rates', () => {
    expect(computeBoolRate(samples, 'flag')).toMatchObject({ n: 3, trueCount: 2 });
    const byStep = buildBoolRateByStep(samples, 'flag');
    expect(byStep.find(p => p.step === 0)!.rate).toBeCloseTo(0.5);
    expect(byStep.find(p => p.step === 1)!.rate).toBe(1);
  });
  it('works on bool grade metrics via source=grade', () => {
    const g = [
      makeSample({ grades: { reward_hack: [makeGradeEntry(true, 'bool')] } } as Partial<Sample>),
      makeSample({ grades: { reward_hack: [makeGradeEntry(false, 'bool')] } } as Partial<Sample>),
    ];
    expect(computeBoolRate(g, 'reward_hack', 'grade')).toMatchObject({ n: 2, trueCount: 1 });
    const bySource = buildBoolRateBySource(g, 'reward_hack', 'grade');
    expect(bySource[0].rate).toBeCloseTo(0.5);
  });
});
