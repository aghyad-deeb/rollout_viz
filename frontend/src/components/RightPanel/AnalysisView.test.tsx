import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisView, HistTip } from './AnalysisView';
import { makeSample, makeGradeEntry } from '../../test/fixtures';
import type { Sample } from '../../types';

// recharts' ResponsiveContainer needs a sized parent, which jsdom lacks. Give it
// a fixed size so charts mount without warnings; we assert on the surrounding DOM.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 300 });
  // recharts 3 sizes ResponsiveContainer from getBoundingClientRect, which jsdom
  // zeroes out — give it a real box so chart internals (axes, ticks) render.
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 600, height: 300, top: 0, left: 0, bottom: 300, right: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

// Inline styles that would clip a chart into a nested scrollbox.
function scrollBoxesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
    d => d.style.maxHeight !== '' || d.style.overflowY === 'auto',
  );
}

const sample = (reward: number, data_source: string, step = 0): Sample =>
  makeSample({ attributes: { reward, data_source, step } as Sample['attributes'] });

describe('AnalysisView', () => {
  it('shows an empty state with no samples', () => {
    render(<AnalysisView samples={[]} isDarkMode={false} />);
    expect(screen.getByText('No samples to analyze')).toBeInTheDocument();
  });

  it('reports median and floor share instead of a bare mean', () => {
    const samples = [
      ...Array.from({ length: 8 }, () => sample(-5, 'coding/hack')),
      sample(3, 'coding/clean'),
      sample(7, 'coding/clean'),
    ];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    expect(screen.getByText('Median Reward')).toBeInTheDocument();
    // floor share card present and computed (8/10 = 80%, shown on the tile and
    // the composition legend)
    expect(screen.getByText(/At Floor/)).toBeInTheDocument();
    expect(screen.getAllByText('80%').length).toBeGreaterThanOrEqual(1);
    // honesty banner names the denominator
    expect(screen.getByText(/Analyzing/)).toBeInTheDocument();
  });

  it('surfaces grade metrics on the dashboard', () => {
    const samples = [
      makeSample({ grades: { safety: [makeGradeEntry(true, 'bool')] } } as Partial<Sample>),
      makeSample({ grades: { safety: [makeGradeEntry(false, 'bool')] } } as Partial<Sample>),
    ];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    expect(screen.getByText('Grade Metrics')).toBeInTheDocument();
    expect(screen.getByText('safety')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument(); // 1 of 2 true
  });

  it('does not silently truncate categories — offers "Show all" past the top N', () => {
    const samples = Array.from({ length: 25 }, (_, i) => sample(0, `env/source_${i}`));
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    // two "Show all" buttons (counts + reward charts)
    const showAll = screen.getAllByText('Show all');
    expect(showAll.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/top 15 of 25/).length).toBeGreaterThanOrEqual(1);
  });

  it('toggles the log-scale control on the distribution', () => {
    // mixed rewards — a constant corpus hides the histogram controls entirely
    const samples = [...Array.from({ length: 9 }, () => sample(-5, 'x/y')), sample(3, 'x/y')];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    const logBtn = screen.getByTitle(/logarithmic/i);
    expect(screen.queryByText('log count axis')).not.toBeInTheDocument();
    fireEvent.click(logBtn);
    expect(screen.getByText('log count axis')).toBeInTheDocument();
  });

  it('has independent per-surface median/mean toggles', () => {
    const samples = [
      ...Array.from({ length: 8 }, () => sample(-5, 'a/b')),
      sample(3, 'a/b'),
      sample(7, 'a/b'),
    ];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    // both default to median
    expect(screen.getByText('Median Reward')).toBeInTheDocument();
    expect(screen.getByText('Median Reward by Data Source')).toBeInTheDocument();

    // flip ONLY the KPI tile → chart stays median
    fireEvent.click(screen.getByTitle(/Mean summary/i));
    expect(screen.getByText('Mean Reward')).toBeInTheDocument();
    expect(screen.getByText('Median Reward by Data Source')).toBeInTheDocument();

    // flip ONLY the chart → tile keeps its own state
    fireEvent.click(screen.getByTitle(/Mean per source/i));
    expect(screen.getByText('Mean Reward by Data Source')).toBeInTheDocument();
    expect(screen.getByText('Mean Reward')).toBeInTheDocument();
  });

  it('offers a metric inspector and charts a selected categorical metric', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeSample({
        attributes: { reward: i, data_source: 'env/x', step: 0, score_value: i % 2 ? 'C' : 'I', run_id: `r${i}` } as Sample['attributes'],
      }),
    );
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    expect(screen.getByText('Inspect a Metric')).toBeInTheDocument();

    // The categorical attribute is offered; high-cardinality run_id is hidden.
    expect(screen.getByRole('option', { name: 'score_value' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'run_id' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:score_value' } });
    expect(screen.getByText('score_value — distribution')).toBeInTheDocument();
    expect(screen.getByText('score_value — composition by step')).toBeInTheDocument();
  });

  it('reveals id/axis fields only when "all fields" is toggled', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeSample({ attributes: { reward: i, data_source: 'env/x', step: 0, run_id: `r${i}` } as Sample['attributes'] }),
    );
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    expect(screen.queryByRole('option', { name: 'run_id' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('all fields'));
    expect(screen.getByRole('option', { name: 'run_id' })).toBeInTheDocument();
  });

  it('renders a single-step summary instead of a flat line', () => {
    const samples = [sample(1, 'x', 5), sample(3, 'x', 5)];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    expect(screen.getByText(/Single step \(5\)/)).toBeInTheDocument();
  });

  it('presents a constant-reward corpus neutrally instead of an "At Floor" alarm', () => {
    // Backend fills missing reward with 0.0 → plain conversation files arrive all-zero.
    const samples = Array.from({ length: 4 }, () => sample(0, 'env/x'));
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    // KPI tile flips to a neutral constant summary, hedged (not asserted) about the cause
    expect(screen.getByText('Constant Reward')).toBeInTheDocument();
    expect(screen.queryByText(/At Floor/)).not.toBeInTheDocument();
    expect(screen.getByText('all 4 samples = 0.00 · source may not record rewards')).toBeInTheDocument();
    // distribution card drops its controls and explains there is nothing to plot
    expect(screen.queryByTitle(/logarithmic/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle('10 bins')).not.toBeInTheDocument();
    expect(screen.getByText(/Reward is constant \(0\.00\) across all 4 samples — no distribution to plot/)).toBeInTheDocument();
    // composition strip shows one neutral segment, not the red floor split
    expect(screen.getByText('constant (0.00)')).toBeInTheDocument();
    expect(screen.queryByText(/at floor/)).not.toBeInTheDocument();
  });

  it('does not hedge about missing rewards when the constant is non-zero', () => {
    const samples = Array.from({ length: 3 }, () => sample(-5, 'env/x'));
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    expect(screen.getByText('Constant Reward')).toBeInTheDocument();
    expect(screen.getByText('all 3 samples = -5.00')).toBeInTheDocument();
    expect(screen.queryByText(/source may not record rewards/)).not.toBeInTheDocument();
  });

  it('makes boolean grade tiles clickable to open the inspector', () => {
    const samples = [
      makeSample({ grades: { safety: [makeGradeEntry(true, 'bool')] } } as Partial<Sample>),
      makeSample({ grades: { safety: [makeGradeEntry(false, 'bool')] } } as Partial<Sample>),
    ];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    const tile = screen.getByRole('button', { name: 'Inspect safety' });
    expect(tile).toHaveTextContent('inspect →'); // explicit affordance hint
    fireEvent.click(tile);
    expect(screen.getByText('safety — true rate')).toBeInTheDocument();
  });

  it('keeps numeric grade tiles as plain tiles (nothing to inspect)', () => {
    const samples = [
      makeSample({ grades: { quality: [makeGradeEntry(0.5, 'float')] } } as Partial<Sample>),
      makeSample({ grades: { quality: [makeGradeEntry(0.7, 'float')] } } as Partial<Sample>),
    ];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    expect(screen.getByText('quality')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inspect quality' })).not.toBeInTheDocument();
  });

  it('shows an accurate message for unique-per-sample id fields', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeSample({ attributes: { reward: i, data_source: 'env/x', step: 0, run_id: `r${i}` } as Sample['attributes'] }),
    );
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    fireEvent.click(screen.getByText('all fields'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:run_id' } });
    expect(screen.getByText(/is distinct for nearly every sample \(6 of 6\) — nothing to aggregate/)).toBeInTheDocument();
  });

  it('explains axis fields instead of the wrong numeric-grades fallback', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeSample({ attributes: { reward: i, data_source: 'env/x', step: i % 2 } as Sample['attributes'] }),
    );
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    fireEvent.click(screen.getByText('all fields'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:step' } });
    expect(screen.getByText(/is an axis — charts above already break down by step/)).toBeInTheDocument();
  });

  it('charts value counts for repeated id fields like source_file', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeSample({ attributes: { reward: i, data_source: 'env/x', step: 0, source_file: i < 4 ? 'a.jsonl' : 'b.jsonl' } as Sample['attributes'] }),
    );
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    fireEvent.click(screen.getByText('all fields'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:source_file' } });
    expect(screen.getByText('source_file — distribution')).toBeInTheDocument();
    expect(screen.getByText(/2 distinct values/)).toBeInTheDocument();
  });

  it('groups categories past the top 8 into an "other" bucket by step', () => {
    const rows: Sample[] = [];
    for (let step = 0; step < 2; step++) {
      for (let i = 0; i < 10; i++) {
        rows.push(makeSample({ attributes: { reward: i, data_source: 'env/x', step, verdict: `v${i}` } as Sample['attributes'] }));
      }
    }
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:verdict' } });
    expect(screen.getByText('top 8 of 10 values shown · rest grouped as "other"')).toBeInTheDocument();
  });

  it('omits the "other" bucket when 8 or fewer values exist', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeSample({ attributes: { reward: i, data_source: 'env/x', step: i % 2, verdict: `v${i % 4}` } as Sample['attributes'] }),
    );
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:verdict' } });
    expect(screen.getByText('verdict — composition by step')).toBeInTheDocument();
    expect(screen.queryByText(/rest grouped as "other"/)).not.toBeInTheDocument();
  });

  it('grows expanded per-source charts into the page instead of a nested scrollbox', () => {
    const samples = Array.from({ length: 25 }, (_, i) => sample(0, `env/source_${i}`));
    const { container } = render(<AnalysisView samples={samples} isDarkMode={false} />);
    for (const btn of screen.getAllByText('Show all')) fireEvent.click(btn);
    // caption flips from "top 15 of 25" to the full count
    expect(screen.getByText('all 25 sources')).toBeInTheDocument();
    // no wrapper caps the chart height or adds an inner scrollbar (the x-axis
    // used to be stranded below the 360px box)
    expect(scrollBoxesIn(container)).toHaveLength(0);
  });

  it('renders the bool true-rate-by-source chart without a scrollbox', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeSample({ attributes: { reward: 0, data_source: `env/s${i}`, step: 0, flag: i % 2 === 0 } as Sample['attributes'] }),
    );
    const { container } = render(<AnalysisView samples={rows} isDarkMode={false} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:flag' } });
    expect(screen.getByText('flag — true rate by source')).toBeInTheDocument();
    expect(scrollBoxesIn(container)).toHaveLength(0);
  });

  it('disambiguates colliding y-axis labels for a path-valued categorical', () => {
    // Long shared head: pre-fix, both full paths head-truncated to the SAME
    // 22-char label. The disambiguated suffixes fit untruncated and differ.
    const rows = [
      ...Array.from({ length: 3 }, () =>
        makeSample({ attributes: { reward: 0, data_source: 'env/x', step: 0, eval_path: 'agentic_coding/train/split_a/reward_check' } as Sample['attributes'] }),
      ),
      ...Array.from({ length: 2 }, () =>
        makeSample({ attributes: { reward: 0, data_source: 'env/x', step: 0, eval_path: 'agentic_coding/train/split_b/reward_check' } as Sample['attributes'] }),
      ),
    ];
    render(<AnalysisView samples={rows} isDarkMode={false} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'attribute:eval_path' } });
    const card = screen.getByText('eval_path — distribution').closest('.analysis-card') as HTMLElement;
    // visible tick text only (each tick <text> also carries a hover <title>)
    const tickTexts = Array.from(card.querySelectorAll('.recharts-yAxis-tick-labels text')).map(el =>
      Array.from(el.childNodes)
        .filter(n => n.nodeName.toLowerCase() !== 'title')
        .map(n => n.textContent)
        .join(''),
    );
    expect(tickTexts).toHaveLength(2);
    expect(new Set(tickTexts).size).toBe(tickTexts.length); // pairwise distinct
    expect(tickTexts).toEqual(expect.arrayContaining(['split_a/reward_check', 'split_b/reward_check']));
  });

  it('wraps long metric labels instead of truncating them', () => {
    const samples = [
      makeSample({ grades: { extremely_long_snake_case_metric_name: [makeGradeEntry(0.5, 'float')] } } as Partial<Sample>),
    ];
    render(<AnalysisView samples={samples} isDarkMode={false} />);
    const statLabel = screen.getByTitle('Total Samples');
    expect(statLabel.className).toContain('break-words');
    expect(statLabel.className).not.toContain('truncate');
    const gradeLabel = screen.getByTitle('extremely_long_snake_case_metric_name');
    expect(gradeLabel.className).toContain('break-words');
    expect(gradeLabel.className).not.toContain('truncate');
  });
});

describe('HistTip', () => {
  const negBin = { label: '-0.5', rangeMin: -0.5, rangeMax: 0, count: 3, pct: 0.3, isNegative: true };

  it('defaults to reward wording with the diverging (red) swatch on negative bins', () => {
    const { container } = render(<HistTip active payload={[{ payload: negBin }]} isDarkMode={false} />);
    expect(container.textContent).toContain('reward -0.5 … 0.0');
    const swatch = container.querySelector('span') as HTMLElement;
    expect(['#e76f51', 'rgb(231, 111, 81)']).toContain(swatch.style.background);
  });

  it('names the inspected metric and drops the reward-only red coloring', () => {
    const { container } = render(<HistTip active payload={[{ payload: negBin }]} isDarkMode={false} name="score_num" />);
    expect(container.textContent).toContain('score_num -0.5 … 0.0');
    expect(container.textContent).not.toContain('reward');
    const swatch = container.querySelector('span') as HTMLElement;
    expect(['#2a9d8f', 'rgb(42, 157, 143)']).toContain(swatch.style.background);
  });
});

// Keep vi referenced for environments that tree-shake unused imports.
void vi;
