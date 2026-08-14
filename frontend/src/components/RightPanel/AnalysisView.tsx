import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  ComposedChart,
  Line,
  Area,
  ErrorBar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
  ResponsiveContainer,
} from 'recharts';
import type { Sample } from '../../types';
import {
  computeRewardStats,
  buildRewardHistogram,
  buildStepSeries,
  buildSourceBreakdown,
  coveredFraction,
  buildGradeSummary,
  describeMetrics,
  computeNumericStats,
  buildNumericHistogram,
  buildNumericStepSeries,
  buildNumericSourceBreakdown,
  buildCategoryBreakdown,
  buildCategoryByStep,
  buildBoolRateByStep,
  buildBoolRateBySource,
  computeBoolRate,
  disambiguateLabels,
  isAxisField,
  type RewardStats,
  type SourceRow,
  type StepPoint,
  type HistBin,
  type CategoryRow,
  type SourceRatePoint,
} from './analysisData';

interface AnalysisViewProps {
  samples: Sample[];
  isDarkMode: boolean;
}

// App palette → a diverging reward scale: coral (penalized) → gold → teal (rewarded).
const C_NEG = '#e76f51';
const C_MID = '#e9c46a';
const C_POS = '#2a9d8f';
const C_DEEP = '#264653';
const C_ORANGE = '#f4a261';

// Qualitative palette for categorical series (derived from the app tokens).
const CAT_COLORS = ['#2a9d8f', '#264653', '#f4a261', '#e9c46a', '#e76f51', '#5b8fa8', '#9c6b9e', '#8ab17d', '#b5838d', '#6d6875'];
const categoryColor = (i: number) => CAT_COLORS[i % CAT_COLORS.length];

const BIN_OPTIONS = [10, 20, 30, 50];
const TOP_N = 15;

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const rise = (i: number): CSSProperties => ({ animationDelay: `${i * 55}ms` });

// --- diverging color, anchored to the reward domain so every chart agrees ---
function lerpHex(a: string, b: string, t: number): string {
  const u = Math.max(0, Math.min(1, t));
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const ch = pa.map((c, i) => Math.round(c + (pb[i] - c) * u).toString(16).padStart(2, '0'));
  return `#${ch.join('')}`;
}
function rewardColor(v: number, min: number, max: number): string {
  if (max <= 0) return lerpHex(C_NEG, C_MID, max === min ? 0 : (v - min) / (max - min));
  if (min >= 0) return lerpHex(C_MID, C_POS, max === min ? 1 : (v - min) / (max - min));
  return v < 0 ? lerpHex(C_NEG, C_MID, (v - min) / -min) : lerpHex(C_MID, C_POS, v / max);
}

// Pull the typed datum a recharts tooltip is hovering, without `any`.
function hovered<T>(payload: ReadonlyArray<{ payload?: unknown }> | undefined): T | null {
  const p = payload && payload[0] && payload[0].payload;
  return (p ?? null) as T | null;
}

export function AnalysisView({ samples, isDarkMode }: AnalysisViewProps) {
  const [binCount, setBinCount] = useState(20);
  const [logScale, setLogScale] = useState(false);
  const [expandCounts, setExpandCounts] = useState(false);
  const [expandReward, setExpandReward] = useState(false);
  const [rewardSort, setRewardSort] = useState<'reward' | 'count'>('reward');
  // Per-surface central-tendency toggles (median ⇄ mean), independent so a user
  // can read median in one place and mean in another.
  const [kpiStat, setKpiStat] = useState<'median' | 'mean'>('median');
  const [sourceStat, setSourceStat] = useState<'median' | 'mean'>('median');
  const [inspectSel, setInspectSel] = useState('');     // "source:key" of the inspected metric
  const [showAllFields, setShowAllFields] = useState(false);

  const stats = useMemo(() => computeRewardStats(samples), [samples]);
  // Every reward identical (e.g. plain conversation JSONLs where the backend
  // defaults missing rewards to 0) — there is no floor/spread story to tell.
  const constantReward = stats.n > 0 && stats.min === stats.max;
  const histogram = useMemo(() => buildRewardHistogram(samples, binCount), [samples, binCount]);
  const stepSeries = useMemo(() => buildStepSeries(samples), [samples]);
  const sources = useMemo(() => buildSourceBreakdown(samples), [samples]);
  const grades = useMemo(() => buildGradeSummary(samples), [samples]);

  // --- "Inspect a metric": discover + classify all attributes/grades ---------
  const descriptors = useMemo(() => describeMetrics(samples), [samples]);
  // Grade tiles for these metrics deep-link into the inspector below.
  const inspectableGrades = useMemo(
    () => new Set(descriptors.filter(d => d.source === 'grade' && (d.kind === 'boolean' || d.kind === 'categorical')).map(d => d.key)),
    [descriptors],
  );
  const inspectRef = useRef<HTMLDivElement>(null);
  const inspect = useMemo(() => {
    if (!inspectSel) return null;
    const idx = inspectSel.indexOf(':');
    const source = inspectSel.slice(0, idx) as 'attribute' | 'grade';
    const key = inspectSel.slice(idx + 1);
    return descriptors.find(d => d.source === source && d.key === key) ?? null;
  }, [inspectSel, descriptors]);
  const inspectNumeric = useMemo(() => (inspect && inspect.kind === 'numeric' && inspect.source === 'attribute') ? {
    stats: computeNumericStats(samples, inspect.key),
    hist: buildNumericHistogram(samples, inspect.key, 20),
    steps: buildNumericStepSeries(samples, inspect.key),
    sources: buildNumericSourceBreakdown(samples, inspect.key),
  } : null, [inspect, samples]);
  // `id`-kind fields split three ways: numeric axes (step, rollout_n, …) and
  // unique-per-sample ids get honest messages; repeated string ids
  // (source_file, task_id, …) chart like any categorical.
  const inspectIsAxis = !!inspect && inspect.kind === 'id' && isAxisField(inspect.key);
  const inspectIsUniqueId = !!inspect && inspect.kind === 'id' && !inspectIsAxis && inspect.distinct >= 0.95 * inspect.n;
  const inspectCat = useMemo(() => {
    if (!inspect || inspectIsAxis || inspectIsUniqueId || (inspect.kind !== 'categorical' && inspect.kind !== 'id')) return null;
    const breakdown = buildCategoryBreakdown(samples, inspect.key, inspect.source);
    // Path-valued categories often share a leaf; collision-safe short labels
    // keep the y-axis ticks pairwise distinct (full value stays in the tooltip).
    const labels = disambiguateLabels(breakdown.map(r => r.value));
    return {
      breakdown: breakdown.map(r => ({ ...r, label: labels.get(r.value) ?? r.value })),
      byStep: buildCategoryByStep(samples, inspect.key, inspect.source),
    };
  }, [inspect, inspectIsAxis, inspectIsUniqueId, samples]);
  const inspectBool = useMemo(() => (inspect && inspect.kind === 'boolean') ? {
    overall: computeBoolRate(samples, inspect.key, inspect.source),
    byStep: buildBoolRateByStep(samples, inspect.key, inspect.source),
    bySource: buildBoolRateBySource(samples, inspect.key, inspect.source),
  } : null, [inspect, samples]);

  const steps = useMemo(() => stepSeries.map(p => p.step), [stepSeries]);
  const singleStep = steps.length === 1;

  const rewardRows = useMemo(() => {
    const rows = [...sources];
    if (rewardSort === 'reward') rows.sort((a, b) => b[sourceStat] - a[sourceStat]);
    return rows;
  }, [sources, rewardSort, sourceStat]);

  const textColor = isDarkMode ? '#cbd5e1' : '#475569';
  const mutedColor = isDarkMode ? '#94a3b8' : '#94a3b8';
  const gridColor = isDarkMode ? '#2b3b57' : '#e7ecf1';

  if (samples.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center analysis-surface ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
        <div className="text-center analysis-rise">
          <span className="material-symbols-outlined" style={{ fontSize: 52, opacity: 0.5 }}>monitoring</span>
          <p className="mt-3 text-base font-medium">No samples to analyze</p>
          <p className="text-sm opacity-70">Load a file or adjust filters</p>
        </div>
      </div>
    );
  }

  // per-source chart sizing (expanded charts grow into the page's own scroll,
  // so the x-axis stays reachable — no nested scrollbox)
  const rowH = 28;
  const countShown = expandCounts ? sources.length : Math.min(TOP_N, sources.length);
  const rewardShown = expandReward ? rewardRows.length : Math.min(TOP_N, rewardRows.length);
  const countData = sources.slice(0, countShown);
  const rewardData = rewardRows.slice(0, rewardShown);
  const countHeight = Math.max(230, countData.length * rowH + 24);
  const rewardHeight = Math.max(230, rewardData.length * rowH + 24);
  const hiddenCount = sources.length - countShown;
  const hiddenReward = rewardRows.length - rewardShown;

  const sub = mutedColorClass(isDarkMode);
  const axisTick = { fill: textColor, fontSize: 10 };

  // Resolved keys/labels for each independent toggle.
  const kpiKey = kpiStat;
  const kpiOther: 'median' | 'mean' = kpiStat === 'median' ? 'mean' : 'median';
  const kpiLabel = kpiStat === 'median' ? 'Median' : 'Mean';
  const srcKey = sourceStat;
  const srcLabel = sourceStat === 'median' ? 'Median' : 'Mean';

  return (
    <div className="h-full overflow-auto custom-scrollbar analysis-surface px-5 py-4">
      {/* Header + honesty banner + reward scale key */}
      <div className="flex items-start justify-between gap-4 mb-4 analysis-rise" style={rise(0)}>
        <div>
          <h2 className={`text-base font-semibold tracking-tight ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            Corpus Analysis
          </h2>
          <div className={`text-xs mt-0.5 ${sub}`}>
            Analyzing <span className="font-data font-medium">{stats.n.toLocaleString()}</span> samples in the current
            filter · {sources.length} data source{sources.length === 1 ? '' : 's'}
            {grades.length > 0 && <> · {grades.length} grade metric{grades.length === 1 ? '' : 's'}</>}
            {singleStep ? <> · step {steps[0]}</> : steps.length > 1 && <> · steps {steps[0]}–{steps[steps.length - 1]}</>}
          </div>
        </div>
        <ScaleLegend />
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <StatTile accent={C_POS} label="Total Samples" value={stats.n.toLocaleString()} delay={1} dark={isDarkMode} />
        <StatTile
          accent={C_MID}
          label={`${kpiLabel} Reward`}
          value={fmt(stats[kpiKey])}
          sub={`${kpiOther} ${fmt(stats[kpiOther])} · ${fmt(stats.min)} to ${fmt(stats.max)}`}
          control={<StatToggle value={kpiStat} onChange={setKpiStat} scope="summary" />}
          delay={2}
          dark={isDarkMode}
        />
        {constantReward ? (
          // A constant corpus has no floor share worth alarming about — state the
          // constant neutrally. A constant of exactly 0 often means the source
          // simply omitted rewards (the backend defaults them to 0), but we can't
          // tell defaulted from recorded zeros, so only hint.
          <StatTile
            accent={C_MID}
            label="Constant Reward"
            value={fmt(stats.min)}
            sub={`all ${stats.n.toLocaleString()} samples = ${fmt(stats.min)}${stats.min === 0 ? ' · source may not record rewards' : ''}`}
            delay={3}
            dark={isDarkMode}
          />
        ) : (
          <StatTile
            accent={C_NEG}
            label={`At Floor (${fmt(stats.floorValue)})`}
            value={pct(stats.floorPct)}
            valueColor={stats.floorPct > 0.5 ? C_NEG : undefined}
            sub={`${pct(stats.negativePct)} negative`}
            delay={3}
            dark={isDarkMode}
          />
        )}
        <StatTile
          accent={C_DEEP}
          label={singleStep ? 'Step' : 'Steps'}
          value={singleStep ? String(steps[0]) : steps.length > 1 ? `${steps[0]}–${steps[steps.length - 1]}` : '—'}
          sub={!singleStep && steps.length > 1 ? `${steps.length} distinct` : undefined}
          delay={4}
          dark={isDarkMode}
        />
      </div>

      {/* Reward composition — the whole shape of the corpus in one strip */}
      <div className="analysis-card analysis-rise p-4 mb-3" style={rise(5)}>
        <CompositionBar stats={stats} dark={isDarkMode} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* Reward Distribution */}
        <Card delay={6}>
          <CardHead
            title="Reward Distribution"
            dark={isDarkMode}
            right={constantReward ? undefined : (
              <div className="flex items-center gap-2 presentation-chrome">
                <Segmented
                  ariaLabel="bin count"
                  value={binCount}
                  onChange={setBinCount}
                  options={BIN_OPTIONS.map(b => ({ value: b, label: String(b), title: `${b} bins` }))}
                />
                <Segmented
                  ariaLabel="count scale"
                  value={logScale}
                  onChange={setLogScale}
                  options={[
                    { value: false, label: 'lin', title: 'Linear count axis' },
                    { value: true, label: 'log', title: 'Logarithmic count axis — reveals small bins hidden behind a large spike' },
                  ]}
                />
              </div>
            )}
          />
          {constantReward ? (
            // Single-value corpus — a one-bar histogram would only mislead.
            <div className="h-[250px] flex flex-col items-center justify-center text-center gap-1.5">
              <span className="material-symbols-outlined" style={{ fontSize: 30, opacity: 0.4 }}>horizontal_rule</span>
              <div className={`text-xs ${sub}`}>
                Reward is constant ({fmt(stats.min)}) across all {stats.n.toLocaleString()} samples — no distribution to plot
              </div>
            </div>
          ) : (
            <>
              <div className={`text-xs mb-2 ${sub} flex items-center gap-2 flex-wrap`}>
                <Chip color={C_POS}>median {fmt(stats.median)}</Chip>
                <Chip color={C_MID}>mean {fmt(stats.mean)}</Chip>
                {stats.floorPct > 0 && <Chip color={C_NEG}>floor {fmt(stats.floorValue)} · {pct(stats.floorPct)}</Chip>}
                {logScale && <span className="font-medium opacity-80">log count axis</span>}
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={histogram} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridColor} vertical={false} />
                  <XAxis dataKey="label" tick={axisTick} angle={-45} textAnchor="end" height={48} tickLine={false} axisLine={{ stroke: gridColor }} interval="preserveStartEnd" minTickGap={12} />
                  <YAxis
                    tick={axisTick}
                    tickLine={false}
                    axisLine={false}
                    width={38}
                    scale={logScale ? 'log' : 'auto'}
                    domain={logScale ? [0.9, 'auto'] : [0, 'auto']}
                    allowDataOverflow={logScale}
                  />
                  <Tooltip content={<HistTip isDarkMode={isDarkMode} />} cursor={{ fill: isDarkMode ? '#ffffff10' : '#26465310' }} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} animationDuration={650}>
                    {histogram.map((b, i) => (
                      <Cell key={i} fill={rewardColor((b.rangeMin + b.rangeMax) / 2, stats.min, stats.max)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
        </Card>

        {/* Reward by Step */}
        <Card delay={7}>
          <CardHead title="Reward by Step" dark={isDarkMode} />
          <div className={`text-xs mb-2 ${sub}`}>median (line) · mean ±1 SD (bars) · dot size ∝ n</div>
          {singleStep ? (
            <div className="h-[250px] flex flex-col items-center justify-center text-center gap-1.5">
              <span className="material-symbols-outlined" style={{ fontSize: 30, opacity: 0.4 }}>linear_scale</span>
              <div className={`text-xs ${sub}`}>Single step ({steps[0]}) — no trend to plot</div>
              <div className={`font-data text-lg font-semibold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                median {fmt(stepSeries[0].median)} · mean {fmt(stepSeries[0].mean)}
              </div>
              <div className={`text-xs ${sub}`}>
                range {fmt(stepSeries[0].min)} … {fmt(stepSeries[0].max)} · ±1 SD {fmt(stepSeries[0].std)} · n = {stepSeries[0].n}
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <ComposedChart data={stepSeries} margin={{ top: 4, right: 10, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="medianFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C_POS} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={C_POS} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" stroke={gridColor} vertical={false} />
                <XAxis dataKey="step" tick={axisTick} tickLine={false} axisLine={{ stroke: gridColor }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} width={38} />
                <Tooltip content={<StepTip isDarkMode={isDarkMode} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="median" stroke="none" fill="url(#medianFill)" legendType="none" tooltipType="none" isAnimationActive={false} />
                <Line type="monotone" dataKey="mean" name="mean ±1 SD" stroke={C_MID} strokeWidth={1.5} strokeDasharray="4 3" dot={false} animationDuration={650}>
                  <ErrorBar dataKey="std" width={4} strokeWidth={1} stroke={mutedColor} direction="y" />
                </Line>
                <Line type="monotone" dataKey="median" name="median" stroke={C_POS} strokeWidth={2.5} dot={<StepDot />} animationDuration={650} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Samples by Data Source */}
        <Card delay={8}>
          <CardHead
            title="Samples by Data Source"
            dark={isDarkMode}
            right={sources.length > TOP_N && <ExpandBtn expanded={expandCounts} onClick={() => setExpandCounts(v => !v)} />}
          />
          <div className={`text-xs mb-2 ${sub}`}>
            {hiddenCount > 0
              ? `top ${countShown} of ${sources.length} · these cover ${pct(coveredFraction(sources, countShown))} of samples`
              : `all ${sources.length} sources`}
          </div>
          <ResponsiveContainer width="100%" height={countHeight}>
            <BarChart data={countData} layout="vertical" margin={{ left: 6, right: 40, top: 2, bottom: 2 }}>
              <CartesianGrid strokeDasharray="2 4" stroke={gridColor} horizontal={false} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="label" tick={<CatTick dark={isDarkMode} />} width={134} interval={0} tickLine={false} axisLine={false} />
              <Tooltip content={<SourceTip isDarkMode={isDarkMode} />} cursor={{ fill: isDarkMode ? '#ffffff10' : '#26465310' }} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ zIndex: 30 }} />
              <Bar dataKey="count" fill={C_DEEP} radius={[0, 5, 5, 0]} animationDuration={650}>
                <LabelList dataKey="count" position="right" className="font-data" style={{ fill: mutedColor, fontSize: 10 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Median Reward by Data Source */}
        <Card delay={9}>
          <CardHead
            title={`${srcLabel} Reward by Data Source`}
            dark={isDarkMode}
            right={
              <div className="flex items-center gap-2 presentation-chrome">
                <StatToggle value={sourceStat} onChange={setSourceStat} scope="per source" />
                <Segmented
                  ariaLabel="sort order"
                  value={rewardSort}
                  onChange={setRewardSort}
                  options={[
                    { value: 'reward', label: 'reward', title: `Sort by ${sourceStat} reward` },
                    { value: 'count', label: 'count', title: 'Sort by sample count' },
                  ]}
                />
                {rewardRows.length > TOP_N && <ExpandBtn expanded={expandReward} onClick={() => setExpandReward(v => !v)} />}
              </div>
            }
          />
          <div className={`text-xs mb-2 ${sub}`}>
            {sourceStat} per source ({sourceStat === 'median' ? 'robust to' : 'skewed by'} the floor) · n in tooltip
            {hiddenReward > 0 && <> · top {rewardShown} of {rewardRows.length}</>}
          </div>
          <ResponsiveContainer width="100%" height={rewardHeight}>
            <BarChart data={rewardData} layout="vertical" margin={{ left: 6, right: 40, top: 2, bottom: 2 }}>
              <CartesianGrid strokeDasharray="2 4" stroke={gridColor} horizontal={false} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="label" tick={<CatTick dark={isDarkMode} />} width={134} interval={0} tickLine={false} axisLine={false} />
              <Tooltip content={<SourceTip isDarkMode={isDarkMode} />} cursor={{ fill: isDarkMode ? '#ffffff10' : '#26465310' }} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ zIndex: 30 }} />
              <Bar dataKey={srcKey} radius={[0, 5, 5, 0]} animationDuration={650}>
                {rewardData.map((r, i) => (
                  <Cell key={i} fill={rewardColor(r[srcKey], stats.min, stats.max)} />
                ))}
                <LabelList dataKey={srcKey} position="right" className="font-data" formatter={(v) => fmt(Number(v), 1)} style={{ fill: mutedColor, fontSize: 10 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Grade metrics — the content signal, on the dashboard */}
      {grades.length > 0 && (
        <div className="mt-4 analysis-rise" style={rise(10)}>
          <h3 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${sub}`}>Grade Metrics</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {grades.map((g, i) => {
              const tileStyle = { ...rise(11 + i), ['--tile-accent']: C_ORANGE } as CSSProperties;
              const body = (
                <>
                  <div className={`text-[11px] uppercase tracking-wide min-w-0 break-words leading-tight ${sub}`} title={g.metric}>{g.metric}</div>
                  {g.isBool ? (
                    <>
                      <div className={`font-data text-2xl font-semibold mt-0.5 ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>{pct(g.trueRate ?? 0)}</div>
                      <div className={`text-xs mt-0.5 ${sub}`}>graded true · n = {g.n}</div>
                    </>
                  ) : g.isNumeric ? (
                    <>
                      <div className={`font-data text-2xl font-semibold mt-0.5 ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>{fmt(g.mean ?? 0)}</div>
                      <div className={`text-xs mt-0.5 ${sub}`}>mean · {fmt(g.min ?? 0)}–{fmt(g.max ?? 0)} · n = {g.n}</div>
                    </>
                  ) : (
                    <>
                      <div className={`font-data text-2xl font-semibold mt-0.5 ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>—</div>
                      <div className={`text-xs mt-0.5 ${sub}`}>freeform · {g.n} responses</div>
                    </>
                  )}
                </>
              );
              // Bool/categorical grade tiles deep-link into the inspector below.
              if (!inspectableGrades.has(g.metric)) {
                return (
                  <div key={g.metric} className="analysis-card analysis-tile analysis-rise p-4 pl-5" style={tileStyle}>
                    {body}
                  </div>
                );
              }
              return (
                <button
                  key={g.metric}
                  type="button"
                  aria-label={`Inspect ${g.metric}`}
                  onClick={() => {
                    setInspectSel(`grade:${g.metric}`);
                    // optional-call guard: jsdom has no scrollIntoView
                    inspectRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                  }}
                  className="analysis-card analysis-tile analysis-rise p-4 pl-5 w-full text-left cursor-pointer group"
                  style={tileStyle}
                >
                  {body}
                  <div className={`text-[10px] mt-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity ${sub}`}>inspect →</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Inspect any metric — numeric / categorical / boolean / grade */}
      <div ref={inspectRef} className="mt-4 analysis-rise" style={rise(12)}>
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <h3 className={`text-xs font-semibold uppercase tracking-wide ${sub}`}>Inspect a Metric</h3>
          <div className="flex items-center gap-2 presentation-chrome">
            <select
              value={inspectSel}
              onChange={e => setInspectSel(e.target.value)}
              className={`text-xs px-2 py-1 rounded border ${isDarkMode ? 'border-gray-700 bg-gray-800 text-gray-200' : 'border-gray-300 bg-white text-gray-700'}`}
            >
              <option value="">Choose a metric…</option>
              {(() => {
                const num = descriptors.filter(d => d.source === 'attribute' && d.kind === 'numeric');
                const cat = descriptors.filter(d => d.kind === 'categorical');
                const boolean = descriptors.filter(d => d.kind === 'boolean');
                const ids = descriptors.filter(d => d.kind === 'id');
                const opt = (d: typeof descriptors[number]) => (
                  <option key={`${d.source}:${d.key}`} value={`${d.source}:${d.key}`}>
                    {d.key}{d.source === 'grade' ? ' (grade)' : ''}
                  </option>
                );
                return (
                  <>
                    {num.length > 0 && <optgroup label="Numeric">{num.map(opt)}</optgroup>}
                    {cat.length > 0 && <optgroup label="Categorical">{cat.map(opt)}</optgroup>}
                    {boolean.length > 0 && <optgroup label="Boolean & grades">{boolean.map(opt)}</optgroup>}
                    {showAllFields && ids.length > 0 && <optgroup label="Identifiers / axes">{ids.map(opt)}</optgroup>}
                  </>
                );
              })()}
            </select>
            <button onClick={() => setShowAllFields(v => !v)} className="seg-btn" data-active={showAllFields} style={{ border: '1px solid var(--border-color)' }} title="Show high-cardinality id / axis fields too">
              all fields
            </button>
          </div>
        </div>

        {!inspect ? (
          <Card delay={13}>
            <div className={`text-xs ${sub} py-8 text-center`}>
              Pick a metric to chart its distribution, trend across steps, and breakdown by data source.
            </div>
          </Card>
        ) : inspectIsAxis ? (
          <Card delay={13}>
            <div className={`text-xs ${sub} py-8 text-center`}>
              “{inspect.key}” is an axis — charts above already break down by step.
            </div>
          </Card>
        ) : inspectIsUniqueId ? (
          <Card delay={13}>
            <div className={`text-xs ${sub} py-8 text-center`}>
              “{inspect.key}” is distinct for nearly every sample ({inspect.distinct.toLocaleString()} of {inspect.n.toLocaleString()}) — nothing to aggregate.
            </div>
          </Card>
        ) : inspectNumeric ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <Card delay={13}>
              <CardHead title={`${inspect.key} — distribution`} dark={isDarkMode} />
              <div className={`text-xs mb-2 ${sub}`}>median {fmt(inspectNumeric.stats.median)} · mean {fmt(inspectNumeric.stats.mean)} · n {inspectNumeric.stats.n}</div>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={inspectNumeric.hist} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridColor} vertical={false} />
                  <XAxis dataKey="label" tick={axisTick} angle={-45} textAnchor="end" height={48} tickLine={false} axisLine={{ stroke: gridColor }} interval="preserveStartEnd" minTickGap={12} />
                  <YAxis tick={axisTick} tickLine={false} axisLine={false} width={38} />
                  <Tooltip content={<HistTip isDarkMode={isDarkMode} name={inspect.key} />} cursor={{ fill: 'transparent' }} />
                  <Bar dataKey="count" fill={C_POS} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <Card delay={14}>
              <CardHead title={`${inspect.key} — by step`} dark={isDarkMode} />
              {inspectNumeric.steps.length <= 1 ? (
                <div className="h-[230px] flex flex-col items-center justify-center text-center gap-1">
                  <div className={`text-xs ${sub}`}>Single step — no trend to plot</div>
                  {inspectNumeric.steps[0] && (
                    <div className={`font-data text-lg font-semibold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>median {fmt(inspectNumeric.steps[0].median)} · mean {fmt(inspectNumeric.steps[0].mean)}</div>
                  )}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={inspectNumeric.steps} margin={{ top: 4, right: 10, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridColor} vertical={false} />
                    <XAxis dataKey="step" tick={axisTick} tickLine={false} axisLine={{ stroke: gridColor }} />
                    <YAxis tick={axisTick} tickLine={false} axisLine={false} width={38} />
                    <Tooltip content={<StepTip isDarkMode={isDarkMode} />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="mean" name="mean ±1 SD" stroke={C_MID} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false}>
                      <ErrorBar dataKey="std" width={4} strokeWidth={1} stroke={mutedColor} direction="y" />
                    </Line>
                    <Line type="monotone" dataKey="median" name="median" stroke={C_POS} strokeWidth={2.5} dot={<StepDot />} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </Card>
          </div>
        ) : inspectCat ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <Card delay={13}>
              <CardHead title={`${inspect.key} — distribution`} dark={isDarkMode} />
              <div className={`text-xs mb-2 ${sub}`}>{inspectCat.breakdown.length} distinct value{inspectCat.breakdown.length !== 1 ? 's' : ''}{inspectCat.breakdown.length > 15 ? ` · top 15 cover ${pct(inspectCat.breakdown.slice(0, 15).reduce((a, r) => a + r.pct, 0))}` : ''}</div>
              <ResponsiveContainer width="100%" height={Math.max(180, Math.min(inspectCat.breakdown.length, 15) * 26 + 24)}>
                <BarChart data={inspectCat.breakdown.slice(0, 15)} layout="vertical" margin={{ left: 6, right: 44, top: 2, bottom: 2 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridColor} horizontal={false} />
                  <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="label" tick={<CatTick dark={isDarkMode} />} width={134} interval={0} tickLine={false} axisLine={false} />
                  <Tooltip content={<CatDistTip isDarkMode={isDarkMode} />} cursor={{ fill: 'transparent' }} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ zIndex: 30 }} />
                  <Bar dataKey="count" radius={[0, 5, 5, 0]} isAnimationActive={false}>
                    {inspectCat.breakdown.slice(0, 15).map((_, i) => <Cell key={i} fill={categoryColor(i)} />)}
                    <LabelList dataKey="count" position="right" className="font-data" style={{ fill: mutedColor, fontSize: 10 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <Card delay={14}>
              <CardHead title={`${inspect.key} — composition by step`} dark={isDarkMode} />
              {(() => {
                const keys = inspectCat.breakdown.slice(0, 8).map(r => r.value);
                // Beyond the top 8 the remainder folds into an "other" bucket so
                // every stack sums to that step's true n. The `__other__` sentinel
                // key can't collide with a real category named "other".
                const hasOther = inspectCat.breakdown.length > 8;
                const data = inspectCat.byStep.map(r => {
                  const top = keys.reduce((a, k) => a + (r.counts[k] ?? 0), 0);
                  return { step: r.step, ...r.counts, __other__: r.n - top };
                });
                if (data.length <= 1) return <div className={`h-[230px] flex items-center justify-center text-xs ${sub}`}>Single step — see distribution</div>;
                return (
                  <>
                    {hasOther && (
                      <div className={`text-xs mb-2 ${sub}`}>top 8 of {inspectCat.breakdown.length} values shown · rest grouped as "other"</div>
                    )}
                    <ResponsiveContainer width="100%" height={230}>
                      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                        <CartesianGrid strokeDasharray="2 4" stroke={gridColor} vertical={false} />
                        <XAxis dataKey="step" tick={axisTick} tickLine={false} axisLine={{ stroke: gridColor }} />
                        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={38} />
                        <Tooltip content={<CatStepTip isDarkMode={isDarkMode} />} cursor={{ fill: 'transparent' }} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ zIndex: 30 }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {keys.map((k, i) => <Bar key={k} dataKey={k} stackId="cat" fill={categoryColor(i)} isAnimationActive={false} />)}
                        {hasOther && <Bar dataKey="__other__" name="other" stackId="cat" fill={mutedColor} isAnimationActive={false} />}
                      </BarChart>
                    </ResponsiveContainer>
                  </>
                );
              })()}
            </Card>
          </div>
        ) : inspectBool ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <Card delay={13}>
              <CardHead title={`${inspect.key} — true rate`} dark={isDarkMode} />
              <div className="flex items-baseline gap-3 mb-2">
                <span className="font-data text-3xl font-semibold" style={{ color: C_POS }}>{pct(inspectBool.overall.rate)}</span>
                <span className={`text-xs ${sub}`}>{inspectBool.overall.trueCount} of {inspectBool.overall.n} true</span>
              </div>
              {inspectBool.byStep.length > 1 ? (
                <ResponsiveContainer width="100%" height={190}>
                  <LineChart data={inspectBool.byStep} margin={{ top: 4, right: 10, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridColor} vertical={false} />
                    <XAxis dataKey="step" tick={axisTick} tickLine={false} axisLine={{ stroke: gridColor }} />
                    <YAxis tick={axisTick} tickLine={false} axisLine={false} width={40} domain={[0, 1]} tickFormatter={(v) => pct(v as number)} />
                    <Tooltip content={<RateStepTip isDarkMode={isDarkMode} />} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ zIndex: 30 }} />
                    <Line type="monotone" dataKey="rate" name="true rate" stroke={C_POS} strokeWidth={2.5} dot={<StepDot />} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <div className={`text-xs ${sub} pb-4`}>Single step — rate shown above.</div>}
            </Card>
            <Card delay={14}>
              <CardHead title={`${inspect.key} — true rate by source`} dark={isDarkMode} />
              <ResponsiveContainer width="100%" height={Math.max(180, Math.min(inspectBool.bySource.length, 15) * 26 + 24)}>
                <BarChart data={inspectBool.bySource.slice(0, 15)} layout="vertical" margin={{ left: 6, right: 48, top: 2, bottom: 2 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridColor} horizontal={false} />
                  <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} domain={[0, 1]} tickFormatter={(v) => pct(v as number)} />
                  <YAxis type="category" dataKey="label" tick={<CatTick dark={isDarkMode} />} width={134} interval={0} tickLine={false} axisLine={false} />
                  <Tooltip content={<RateSourceTip isDarkMode={isDarkMode} />} cursor={{ fill: 'transparent' }} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ zIndex: 30 }} />
                  <Bar dataKey="rate" radius={[0, 5, 5, 0]} isAnimationActive={false}>
                    {inspectBool.bySource.slice(0, 15).map((r, i) => <Cell key={i} fill={lerpHex(C_NEG, C_POS, r.rate)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </div>
        ) : (
          <Card delay={13}>
            <div className={`text-xs ${sub} py-8 text-center`}>No chart for “{inspect.key}” here yet — numeric grade metrics are summarized in the Grade Metrics tiles above.</div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── presentational building blocks (module-level: not recreated per render) ──

function Card({ children, delay }: { children: ReactNode; delay: number }) {
  return (
    <div className="analysis-card analysis-rise p-4" style={rise(delay)}>
      {children}
    </div>
  );
}

function CardHead({ title, right, dark }: { title: string; right?: ReactNode; dark: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-1 min-h-[26px]">
      <h3 className={`text-sm font-semibold tracking-tight ${dark ? 'text-gray-200' : 'text-gray-800'}`}>{title}</h3>
      {right}
    </div>
  );
}

function StatTile({
  accent, label, value, sub, valueColor, control, delay, dark,
}: {
  accent: string; label: string; value: string; sub?: string; valueColor?: string; control?: ReactNode; delay: number; dark: boolean;
}) {
  return (
    <div className="analysis-card analysis-tile analysis-rise p-4 pl-5" style={{ ...rise(delay), ['--tile-accent']: accent } as CSSProperties}>
      <div className="flex items-center justify-between gap-1.5 flex-wrap">
        <div className={`text-[11px] uppercase tracking-wide min-w-0 break-words leading-tight ${mutedColorClass(dark)}`} title={label}>{label}</div>
        {control && <div className="presentation-chrome">{control}</div>}
      </div>
      <div className="font-data text-2xl font-semibold mt-0.5" style={{ color: valueColor ?? (dark ? '#f1f5f9' : '#0f172a') }}>{value}</div>
      {sub && <div className={`text-xs mt-0.5 ${mutedColorClass(dark)}`}>{sub}</div>}
    </div>
  );
}

// median ⇄ mean toggle, reused per surface. `scope` keeps tooltips distinct.
function StatToggle({
  value, onChange, scope,
}: {
  value: 'median' | 'mean'; onChange: (v: 'median' | 'mean') => void; scope: string;
}) {
  return (
    <Segmented
      ariaLabel={`central statistic (${scope})`}
      value={value}
      onChange={onChange}
      options={[
        { value: 'median', label: 'median', title: `Median ${scope} — robust to the reward floor` },
        { value: 'mean', label: 'mean', title: `Mean ${scope} — sensitive to the reward floor` },
      ]}
    />
  );
}

function Segmented<T extends string | number | boolean>({
  options, value, onChange, ariaLabel,
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          className="seg-btn"
          data-active={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ExpandBtn({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="seg-btn presentation-chrome" data-active={expanded} style={{ border: '1px solid var(--border-color)' }}>
      {expanded ? 'Top 15' : 'Show all'}
    </button>
  );
}

function Chip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 font-data">
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
      {children}
    </span>
  );
}

function ScaleLegend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide shrink-0" style={{ color: '#94a3b8' }} title="Diverging reward scale: coral = penalized, gold = neutral, teal = rewarded">
      <span>− reward</span>
      <span style={{ width: 84, height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${C_NEG}, ${C_MID}, ${C_POS})`, display: 'inline-block' }} />
      <span>+</span>
    </div>
  );
}

function CompositionBar({ stats, dark }: { stats: RewardStats; dark: boolean }) {
  const constant = stats.n > 0 && stats.min === stats.max;
  const floorIsNeg = stats.floorValue < 0;
  const segFloor = floorIsNeg ? stats.floorPct : 0;
  const segNegOther = Math.max(0, stats.negativePct - segFloor);
  const segPos = Math.max(0, 1 - stats.negativePct);
  // A constant corpus has no floor-vs-rest split — one neutral segment, no alarm red.
  const segments = constant
    ? [{ label: `constant (${fmt(stats.floorValue)})`, value: 1, color: C_MID }]
    : [
        { label: `at floor (${fmt(stats.floorValue)})`, value: segFloor, color: C_NEG },
        { label: 'negative', value: segNegOther, color: C_ORANGE },
        { label: '≥ 0', value: segPos, color: C_POS },
      ].filter(s => s.value > 0);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className={`text-sm font-semibold tracking-tight ${dark ? 'text-gray-200' : 'text-gray-800'}`}>Reward Composition</h3>
        <span className={`text-xs ${mutedColorClass(dark)}`}>n = <span className="font-data">{stats.n.toLocaleString()}</span></span>
      </div>
      <div className="flex w-full h-3.5 rounded-full overflow-hidden" style={{ background: dark ? '#0f3460' : '#eef2f6' }}>
        {segments.map((s, i) => (
          <div key={i} title={`${s.label}: ${pct(s.value)}`} style={{ width: `${s.value * 100}%`, background: s.color }} className="h-full transition-all" />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {segments.map((s, i) => (
          <span key={i} className={`text-xs inline-flex items-center gap-1.5 ${mutedColorClass(dark)}`}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, display: 'inline-block' }} />
            {s.label} <span className="font-data font-medium" style={{ color: dark ? '#e2e8f0' : '#334155' }}>{pct(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// Step median dot sized by sample count (capped) — conveys n at a glance.
function StepDot(props: { cx?: number; cy?: number; payload?: StepPoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload) return null;
  const r = Math.min(7, 2.5 + Math.log2(payload.n + 1));
  return <circle cx={cx} cy={cy} r={r} fill={C_POS} stroke="#ffffff" strokeWidth={isFiniteRadius(r) ? 1 : 0} />;
}
function isFiniteRadius(r: number) { return Number.isFinite(r) && r > 0; }

function mutedColorClass(dark: boolean) {
  return dark ? 'text-gray-400' : 'text-gray-500';
}

// Data-source labels are the shortest UNIQUE path suffix, whose distinctive
// token sits at the HEAD (e.g. "test_cases_hack/…"); the leaf is often shared.
// So truncate from the tail, keeping the head, and expose the full path on hover.
function headTruncate(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function CatTick(props: { x?: number; y?: number; payload?: { value?: string }; dark?: boolean }) {
  const { x = 0, y = 0, payload, dark } = props;
  const full = String(payload?.value ?? '');
  return (
    <text
      x={x}
      y={y}
      dx={-2}
      dy={3}
      textAnchor="end"
      fontSize={10}
      fontFamily="'IBM Plex Mono', ui-monospace, monospace"
      fill={dark ? '#94a3b8' : '#64748b'}
    >
      <title>{full}</title>
      {headTruncate(full, 22)}
    </text>
  );
}

// ── tooltips ──

function tooltipBoxStyle(dark: boolean): CSSProperties {
  return {
    backgroundColor: dark ? 'rgba(22,33,62,0.96)' : 'rgba(255,255,255,0.98)',
    border: `1px solid ${dark ? '#2b3b57' : '#e5e7eb'}`,
    color: dark ? '#e5e7eb' : '#374151',
    fontSize: 12,
    borderRadius: 8,
    boxShadow: '0 8px 24px -12px rgba(0,0,0,0.4)',
    padding: '8px 10px',
    // Bound width + wrap so long source/value names can't overflow a narrow panel.
    maxWidth: 230,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  };
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  isDarkMode: boolean;
}

function Swatch({ color }: { color: string }) {
  return <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block', marginRight: 6 }} />;
}

// Exported for direct unit testing (still a component, so react-refresh is happy).
export function HistTip({ active, payload, isDarkMode, name = 'reward' }: TipProps & { name?: string }) {
  const b = active ? hovered<HistBin>(payload) : null;
  if (!b) return null;
  // The red/green split only means something on the reward scale; other
  // metrics get the neutral positive swatch.
  const swatch = name === 'reward' && b.isNegative ? C_NEG : C_POS;
  return (
    <div style={tooltipBoxStyle(isDarkMode)}>
      <div className="flex items-center font-data">
        <Swatch color={swatch} />
        {name} {fmt(b.rangeMin, 1)} … {fmt(b.rangeMax, 1)}
      </div>
      <div className="font-semibold font-data mt-0.5">{b.count} samples ({pct(b.pct)})</div>
    </div>
  );
}

function StepTip({ active, payload, isDarkMode }: TipProps) {
  const p = active ? hovered<StepPoint>(payload) : null;
  if (!p) return null;
  const subtle = mutedColorClass(isDarkMode);
  return (
    <div style={tooltipBoxStyle(isDarkMode)} className="space-y-0.5 font-data">
      <div className="font-semibold flex items-center"><Swatch color={C_POS} />step {p.step}</div>
      <div>median {fmt(p.median)} · mean {fmt(p.mean)}</div>
      <div className={subtle}>range {fmt(p.min)} … {fmt(p.max)} · ±1 SD {fmt(p.std)}</div>
      <div className={subtle}>n = {p.n}</div>
    </div>
  );
}

function SourceTip({ active, payload, isDarkMode }: TipProps) {
  const r = active ? hovered<SourceRow>(payload) : null;
  if (!r) return null;
  return (
    <div style={{ ...tooltipBoxStyle(isDarkMode), maxWidth: 210 }} className="space-y-0.5">
      <div className="font-semibold flex items-start"><Swatch color={r.median < 0 ? C_NEG : C_POS} /><span>{r.fullName}</span></div>
      <div className="font-data">{r.count} samples ({pct(r.pct)})</div>
      <div className="font-data">median {fmt(r.median)} · mean {fmt(r.mean)}</div>
      <div className={`font-data ${mutedColorClass(isDarkMode)}`}>{pct(r.floorPct)} at floor</div>
    </div>
  );
}

// --- inspect-section tooltips (bounded width; long names wrap, never clip) ---

function CatDistTip({ active, payload, isDarkMode }: TipProps) {
  const r = active ? hovered<CategoryRow>(payload) : null;
  if (!r) return null;
  return (
    <div style={tooltipBoxStyle(isDarkMode)} className="font-data">
      <div className="font-semibold">{r.value}</div>
      <div>{r.count} ({pct(r.pct)})</div>
    </div>
  );
}

function CatStepTip({ active, payload, isDarkMode }: {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: string; value?: number; color?: string; payload?: { step?: number } }>;
  isDarkMode: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const step = payload[0]?.payload?.step;
  return (
    <div style={tooltipBoxStyle(isDarkMode)} className="font-data space-y-0.5">
      <div className="font-semibold">step {step}</div>
      {payload.filter(e => (e.value ?? 0) > 0).map((e, i) => (
        <div key={i} className="flex items-start"><Swatch color={e.color || C_POS} /><span>{e.name}: {e.value}</span></div>
      ))}
    </div>
  );
}

function RateStepTip({ active, payload, isDarkMode }: TipProps) {
  const p = active ? hovered<{ step: number; n: number; rate: number }>(payload) : null;
  if (!p) return null;
  return (
    <div style={tooltipBoxStyle(isDarkMode)} className="font-data">
      <div className="font-semibold flex items-center"><Swatch color={C_POS} />step {p.step}</div>
      <div>{pct(p.rate)} true · n = {p.n}</div>
    </div>
  );
}

function RateSourceTip({ active, payload, isDarkMode }: TipProps) {
  const r = active ? hovered<SourceRatePoint>(payload) : null;
  if (!r) return null;
  return (
    <div style={tooltipBoxStyle(isDarkMode)} className="font-data space-y-0.5">
      <div className="font-semibold">{r.fullName}</div>
      <div>{pct(r.rate)} true · {r.trueCount}/{r.n}</div>
    </div>
  );
}
