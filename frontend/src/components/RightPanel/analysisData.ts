// Pure, testable aggregation helpers for AnalysisView.
//
// Kept separate from the component so the math can be unit-tested without
// rendering recharts (which needs a sized container jsdom doesn't provide).
//
// Design notes driven by the real corpus shape (verified: ~84% of rewards sit
// at a single floor value, e.g. -5.0; hundreds of data_source paths per file):
//   - The MEAN reward is misleading on floor-saturated data, so every reward
//     summary also reports the MEDIAN and the floor share.
//   - data_source is a "/"-delimited taxonomy; reducing it to its leaf
//     (`.split('/').pop()`) can MERGE two distinct paths that share a leaf.
//     We group on the FULL path and compute collision-safe short labels.
//   - Nothing is silently truncated: callers get the full sorted list plus an
//     honest "covered" fraction so the UI can say "top N of M (X%)".

import type { Sample, GradeType } from '../../types';
import { COMMENTS_METRIC } from '../../utils/humanGrades';

// Reserved human-annotation metrics that ride the grade rails for storage but
// are not judgements — they must never be counted or charted as grade metrics.
// (`human_verdict` deliberately stays: it IS a judgement, just a human one.)
const NON_JUDGEMENT_METRICS: ReadonlySet<string> = new Set([COMMENTS_METRIC]);

// --- basic statistics (single-pass / sort-based, safe at 5k+ samples) ---

export function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function std(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length);
}

/** Widen the narrow SampleAttributes type so arbitrary keys can be read. */
function attrsOf(s: Sample): Record<string, unknown> | undefined {
  return s.attributes as unknown as Record<string, unknown> | undefined;
}

/** Read an arbitrary numeric attribute by key. */
function numericOf(s: Sample, key: string): number | null {
  const v = attrsOf(s)?.[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

// --- reward summary ---

export interface RewardStats {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  std: number;
  floorValue: number; // the minimum reward, treated as the "floor"
  floorCount: number; // how many samples sit exactly at the floor
  floorPct: number; // 0..1
  negativeCount: number;
  negativePct: number; // 0..1
}

const EMPTY_REWARD_STATS: RewardStats = {
  n: 0, mean: 0, median: 0, min: 0, max: 0, std: 0,
  floorValue: 0, floorCount: 0, floorPct: 0, negativeCount: 0, negativePct: 0,
};

export function computeRewardStats(samples: Sample[]): RewardStats {
  return computeNumericStats(samples, 'reward');
}

/** Distribution stats for any numeric attribute (floor = the minimum value). */
export function computeNumericStats(samples: Sample[], key: string): RewardStats {
  const vals: number[] = [];
  let sum = 0, min = Infinity, max = -Infinity, neg = 0;
  for (const s of samples) {
    const r = numericOf(s, key);
    if (r === null) continue;
    vals.push(r);
    sum += r;
    if (r < min) min = r;
    if (r > max) max = r;
    if (r < 0) neg++;
  }
  const n = vals.length;
  if (n === 0) return EMPTY_REWARD_STATS;
  let floorCount = 0;
  for (const r of vals) if (r === min) floorCount++;
  return {
    n,
    mean: sum / n,
    median: median(vals),
    min,
    max,
    std: std(vals),
    floorValue: min,
    floorCount,
    floorPct: floorCount / n,
    negativeCount: neg,
    negativePct: neg / n,
  };
}

// --- reward histogram ---

export interface HistBin {
  label: string; // x-axis label (left edge)
  rangeMin: number;
  rangeMax: number;
  count: number;
  pct: number; // 0..1 of all rewards
  isNegative: boolean; // bin midpoint < 0 — drives red/green coloring
}

export function buildRewardHistogram(samples: Sample[], binCount = 20): HistBin[] {
  return buildNumericHistogram(samples, 'reward', binCount);
}

// toFixed renders tiny negative edges as "-0.0" / "-0.00"; strip the sign so
// the axis never shows a negative zero.
const fmtEdge = (v: number, dp: number): string => {
  const l = v.toFixed(dp);
  return /^-0\.0+$/.test(l) ? l.slice(1) : l;
};

/** Histogram for any numeric attribute. `isNegative` (midpoint<0) drives reward coloring. */
export function buildNumericHistogram(samples: Sample[], key: string, binCount = 20): HistBin[] {
  const vals: number[] = [];
  for (const s of samples) {
    const r = numericOf(s, key);
    if (r !== null) vals.push(r);
  }
  if (vals.length === 0) return [];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const total = vals.length;

  if (min === max) {
    return [{
      label: fmtEdge(min, 2),
      rangeMin: min,
      rangeMax: max,
      count: total,
      pct: 1,
      isNegative: min < 0,
    }];
  }

  const bins = Math.max(1, Math.min(binCount, total));
  const size = (max - min) / bins;
  const out: HistBin[] = [];
  for (let i = 0; i < bins; i++) {
    const rangeMin = min + i * size;
    const rangeMax = min + (i + 1) * size;
    out.push({
      label: fmtEdge(rangeMin, 1),
      rangeMin,
      rangeMax,
      count: 0,
      pct: 0,
      isNegative: (rangeMin + rangeMax) / 2 < 0,
    });
  }
  for (const v of vals) {
    const idx = Math.min(Math.floor((v - min) / size), bins - 1);
    out[idx].count++;
  }
  for (const b of out) b.pct = b.count / total;
  return out;
}

// --- reward by training step ---

export interface StepPoint {
  step: number;
  mean: number;
  median: number;
  std: number;
  min: number;
  max: number;
  n: number;
}

export function buildStepSeries(samples: Sample[]): StepPoint[] {
  return buildNumericStepSeries(samples, 'reward');
}

/** Per-step distribution (mean/median/spread/n) for any numeric attribute. */
export function buildNumericStepSeries(samples: Sample[], key: string): StepPoint[] {
  const grouped = new Map<number, number[]>();
  for (const s of samples) {
    const r = numericOf(s, key);
    if (r === null) continue;
    const step = s.attributes?.step;
    if (typeof step !== 'number') continue;
    const arr = grouped.get(step);
    if (arr) arr.push(r);
    else grouped.set(step, [r]);
  }
  return [...grouped.entries()]
    .map(([step, vals]) => ({
      step,
      mean: mean(vals),
      median: median(vals),
      std: std(vals),
      min: Math.min(...vals),
      max: Math.max(...vals),
      n: vals.length,
    }))
    .sort((a, b) => a.step - b.step);
}

// --- per data-source breakdown (full-path keyed, collision-safe labels) ---

export interface SourceRow {
  fullName: string;
  label: string; // collision-safe short label
  count: number;
  pct: number; // 0..1 of all samples
  mean: number;
  median: number;
  floorPct: number; // share of this source's rewards at the global floor
}

/**
 * Map each full "/"-delimited path to the SHORTEST trailing-segment suffix that
 * is unique across the set, so two paths sharing a leaf don't collapse to the
 * same label. Falls back to the full path when no suffix disambiguates.
 */
export function disambiguateLabels(names: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const partsByName = new Map(names.map(n => [n, n.split('/')]));
  for (const n of names) {
    const parts = partsByName.get(n)!;
    let label = parts[parts.length - 1] || n;
    for (let k = 1; k <= parts.length; k++) {
      const cand = parts.slice(parts.length - k).join('/');
      const collides = names.some(
        o => o !== n && o.split('/').slice(-k).join('/') === cand,
      );
      label = cand;
      if (!collides) break;
    }
    result.set(n, label);
  }
  return result;
}

export function buildSourceBreakdown(samples: Sample[]): SourceRow[] {
  return buildNumericSourceBreakdown(samples, 'reward');
}

/** Per data-source mean/median/floor-share for any numeric attribute. */
export function buildNumericSourceBreakdown(samples: Sample[], key: string): SourceRow[] {
  const grouped = new Map<string, number[]>();
  let floorValue = Infinity;
  for (const s of samples) {
    const r = numericOf(s, key);
    if (r !== null && r < floorValue) floorValue = r;
  }
  let total = 0;
  for (const s of samples) {
    const source = s.attributes?.data_source ?? 'unknown';
    const r = numericOf(s, key);
    const arr = grouped.get(source);
    if (arr) arr.push(r ?? NaN);
    else grouped.set(source, [r ?? NaN]);
    total++;
  }
  if (total === 0) return [];
  const labels = disambiguateLabels([...grouped.keys()]);
  return [...grouped.entries()]
    .map(([fullName, rawRewards]) => {
      const rewards = rawRewards.filter(r => !Number.isNaN(r));
      const floorCount = rewards.filter(r => r === floorValue).length;
      return {
        fullName,
        label: labels.get(fullName) ?? fullName,
        count: rawRewards.length,
        pct: rawRewards.length / total,
        mean: mean(rewards),
        median: median(rewards),
        floorPct: rewards.length ? floorCount / rewards.length : 0,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Fraction of total samples covered by the first `n` rows of a breakdown. */
export function coveredFraction(rows: SourceRow[], n: number): number {
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (total === 0) return 0;
  const top = rows.slice(0, n).reduce((a, r) => a + r.count, 0);
  return top / total;
}

// --- grade metric summaries (the content signal, absent from the old view) ---

export interface GradeMetricSummary {
  metric: string;
  n: number; // samples that have at least one grade for this metric
  isBool: boolean;
  isNumeric: boolean;
  isFreeform: boolean;
  trueRate?: number; // bool metrics: share graded true
  mean?: number; // numeric metrics
  min?: number;
  max?: number;
}

/**
 * Summarize grades using the LATEST entry per metric per sample (matching the
 * app convention that consumers read `grades[metric][last]`). Reserved
 * non-judgement metrics (`comments`) are excluded, so they never appear as
 * grade tiles, in the metric count, or in the inspector's picker.
 */
export function buildGradeSummary(samples: Sample[]): GradeMetricSummary[] {
  const byMetric = new Map<string, { grades: unknown[]; types: Set<GradeType> }>();
  for (const s of samples) {
    const grades = s.grades;
    if (!grades) continue;
    for (const [metric, entries] of Object.entries(grades)) {
      if (NON_JUDGEMENT_METRICS.has(metric)) continue;
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const last = entries[entries.length - 1];
      if (!last) continue;
      let bucket = byMetric.get(metric);
      if (!bucket) {
        bucket = { grades: [], types: new Set() };
        byMetric.set(metric, bucket);
      }
      bucket.grades.push(last.grade);
      if (last.grade_type) bucket.types.add(last.grade_type);
    }
  }

  return [...byMetric.entries()]
    .map(([metric, { grades, types }]) => {
      const n = grades.length;
      const isBool = types.has('bool') || grades.every(g => typeof g === 'boolean');
      const numericVals = grades.filter((g): g is number => typeof g === 'number' && !Number.isNaN(g));
      const isNumeric = !isBool && numericVals.length > 0;
      const isFreeform = !isBool && !isNumeric;
      const summary: GradeMetricSummary = { metric, n, isBool, isNumeric, isFreeform };
      if (isBool) {
        const trueCount = grades.filter(g => g === true).length;
        summary.trueRate = n ? trueCount / n : 0;
      } else if (isNumeric) {
        summary.mean = mean(numericVals);
        summary.min = Math.min(...numericVals);
        summary.max = Math.max(...numericVals);
      }
      return summary;
    })
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

// --- generic metric discovery + categorical / boolean builders --------------

export type MetricKind = 'numeric' | 'categorical' | 'boolean' | 'id' | 'empty';
export type MetricSource = 'attribute' | 'grade';

export interface MetricDescriptor {
  key: string;
  kind: MetricKind;
  n: number;        // non-null sample count
  distinct: number; // distinct non-null values (0 for grades, not computed)
  source: MetricSource;
}

const ID_DISTINCT_ABS = 50;     // string fields with > this many distinct values look like ids
const ID_DISTINCT_FRAC = 0.5;   // ...or > 50% of n distinct
const NUMERIC_MIN_FRAC = 0.9;   // >=90% numeric values → treat as numeric
// High-cardinality identifiers / paths that are never useful to plot.
const ID_KEY_DENYLIST = new Set([
  'run_id', 'task_id', 'eval_id', 'eval_log', 'sample_id', 'log_id',
  'source_file', 'timestamp', 'model_id', 'target_model',
]);
// Numeric fields that are grouping axes, not metrics worth inspecting by default.
const AXIS_NUMERIC_DENYLIST = new Set(['step', 'sample_index', 'rollout_n', 'matrix_log_index']);

/** True for numeric grouping axes (step, rollout_n, …) — dimensions, not metrics. */
export function isAxisField(key: string): boolean {
  return AXIS_NUMERIC_DENYLIST.has(key);
}

/**
 * Classify every attribute key (+ grade metric) found across the corpus into a
 * plottable kind. `id`-kind fields are hidden from the default picker.
 */
export function describeMetrics(samples: Sample[]): MetricDescriptor[] {
  const keys = new Set<string>();
  for (const s of samples) {
    const attrs = attrsOf(s);
    if (attrs) for (const k of Object.keys(attrs)) keys.add(k);
  }

  const out: MetricDescriptor[] = [];
  for (const key of keys) {
    let nonNull = 0, numericCount = 0, boolCount = 0;
    const distinctVals = new Set<unknown>();
    for (const s of samples) {
      const v = attrsOf(s)?.[key];
      if (v === null || v === undefined || v === '') continue;
      nonNull++;
      if (typeof v === 'number' && !Number.isNaN(v)) numericCount++;
      else if (typeof v === 'boolean') boolCount++;
      distinctVals.add(v);
    }
    const distinct = distinctVals.size;
    let kind: MetricKind;
    if (nonNull === 0) {
      kind = 'empty';
    } else if (boolCount === nonNull) {
      kind = 'boolean';
    } else if (numericCount / nonNull >= NUMERIC_MIN_FRAC) {
      kind = AXIS_NUMERIC_DENYLIST.has(key) ? 'id' : 'numeric'; // axes hidden by default
    } else if (ID_KEY_DENYLIST.has(key) || distinct > Math.max(ID_DISTINCT_ABS, ID_DISTINCT_FRAC * nonNull)) {
      kind = 'id';
    } else {
      kind = 'categorical';
    }
    out.push({ key, kind, n: nonNull, distinct, source: 'attribute' });
  }

  // Grade metrics fold in as their own pickable metrics.
  for (const g of buildGradeSummary(samples)) {
    out.push({
      key: g.metric,
      kind: g.isBool ? 'boolean' : g.isNumeric ? 'numeric' : 'categorical',
      n: g.n,
      distinct: 0,
      source: 'grade',
    });
  }
  return out;
}

function catValue(s: Sample, key: string, source: MetricSource): string | null {
  if (source === 'grade') {
    const entries = s.grades?.[key];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const g = entries[entries.length - 1]?.grade;
    return g === null || g === undefined ? null : String(g);
  }
  const v = attrsOf(s)?.[key];
  return v === null || v === undefined || v === '' ? null : String(v);
}

function boolValue(s: Sample, key: string, source: MetricSource): boolean | null {
  if (source === 'grade') {
    const entries = s.grades?.[key];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const g = entries[entries.length - 1]?.grade;
    return typeof g === 'boolean' ? g : null;
  }
  const v = attrsOf(s)?.[key];
  return typeof v === 'boolean' ? v : null;
}

export interface CategoryRow { value: string; count: number; pct: number; }

/** Value counts for a categorical metric, sorted desc. */
export function buildCategoryBreakdown(samples: Sample[], key: string, source: MetricSource = 'attribute'): CategoryRow[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const s of samples) {
    const v = catValue(s, key, source);
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    total++;
  }
  if (total === 0) return [];
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, pct: count / total }))
    .sort((a, b) => b.count - a.count);
}

export interface CategoryStepRow { step: number; n: number; counts: Record<string, number>; }

/** Per-step value composition for a categorical metric (for a stacked share chart). */
export function buildCategoryByStep(samples: Sample[], key: string, source: MetricSource = 'attribute'): CategoryStepRow[] {
  const byStep = new Map<number, { n: number; counts: Record<string, number> }>();
  for (const s of samples) {
    const v = catValue(s, key, source);
    if (v === null) continue;
    const step = s.attributes?.step;
    if (typeof step !== 'number') continue;
    let bucket = byStep.get(step);
    if (!bucket) { bucket = { n: 0, counts: {} }; byStep.set(step, bucket); }
    bucket.n++;
    bucket.counts[v] = (bucket.counts[v] ?? 0) + 1;
  }
  return [...byStep.entries()]
    .map(([step, b]) => ({ step, n: b.n, counts: b.counts }))
    .sort((a, b) => a.step - b.step);
}

export interface RatePoint { step: number; n: number; trueCount: number; rate: number; }

/** True-rate per step for a boolean attribute or bool grade metric. */
export function buildBoolRateByStep(samples: Sample[], key: string, source: MetricSource = 'attribute'): RatePoint[] {
  const byStep = new Map<number, { n: number; t: number }>();
  for (const s of samples) {
    const b = boolValue(s, key, source);
    if (b === null) continue;
    const step = s.attributes?.step;
    if (typeof step !== 'number') continue;
    let bucket = byStep.get(step);
    if (!bucket) { bucket = { n: 0, t: 0 }; byStep.set(step, bucket); }
    bucket.n++;
    if (b) bucket.t++;
  }
  return [...byStep.entries()]
    .map(([step, b]) => ({ step, n: b.n, trueCount: b.t, rate: b.n ? b.t / b.n : 0 }))
    .sort((a, b) => a.step - b.step);
}

export interface SourceRatePoint { fullName: string; label: string; n: number; trueCount: number; rate: number; }

/** True-rate per data_source for a boolean attribute or bool grade metric. */
export function buildBoolRateBySource(samples: Sample[], key: string, source: MetricSource = 'attribute'): SourceRatePoint[] {
  const grouped = new Map<string, { n: number; t: number }>();
  for (const s of samples) {
    const b = boolValue(s, key, source);
    if (b === null) continue;
    const src = s.attributes?.data_source ?? 'unknown';
    let bucket = grouped.get(src);
    if (!bucket) { bucket = { n: 0, t: 0 }; grouped.set(src, bucket); }
    bucket.n++;
    if (b) bucket.t++;
  }
  const labels = disambiguateLabels([...grouped.keys()]);
  return [...grouped.entries()]
    .map(([fullName, b]) => ({ fullName, label: labels.get(fullName) ?? fullName, n: b.n, trueCount: b.t, rate: b.n ? b.t / b.n : 0 }))
    .sort((a, b) => b.n - a.n);
}

/** Overall true-rate for a boolean attribute or bool grade metric. */
export function computeBoolRate(samples: Sample[], key: string, source: MetricSource = 'attribute'): { n: number; trueCount: number; rate: number } {
  let n = 0, t = 0;
  for (const s of samples) {
    const b = boolValue(s, key, source);
    if (b === null) continue;
    n++;
    if (b) t++;
  }
  return { n, trueCount: t, rate: n ? t / n : 0 };
}
