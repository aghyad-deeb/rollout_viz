/**
 * The capture styles live in index.css, not in a component — jsdom never loads
 * that file, so nothing else in the suite can regress-test them. These read the
 * stylesheet as text and pin the handful of rules the exported figure's
 * legibility actually depends on (each one a round-1 critic finding).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PAPER_DPI, PAPER_FONT_SCALE } from './captureImage';

// vitest runs from the frontend package root.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The rule body for one selector (first match), so assertions stay scoped. */
function block(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

/** px authored at screen scale → pt at final (300 DPI) figure size. */
function finalPt(px: number): number {
  return ((px * PAPER_FONT_SCALE) / PAPER_DPI) * 72;
}

describe('capture stylesheet — rule weights', () => {
  it('derives every paper rule weight from ONE --paper-scale var, via calc()', () => {
    const paperVars = block('.capture-paper {');
    expect(paperVars).toContain('--paper-scale:');
    for (const name of ['--paper-box-rule', '--paper-accent-rule', '--paper-hairline']) {
      const rule = paperVars.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1] ?? '';
      expect(rule, name).toContain('calc(');
      expect(rule, name).toContain('var(--paper-scale)');
    }
  });

  it('keeps the fallback --paper-scale in step with PAPER_FONT_SCALE', () => {
    const fallback = Number(block('.capture-paper {').match(/--paper-scale:\s*([\d.]+)/)?.[1]);
    // The clone gets the exact value inline; this literal only covers a clone
    // that somehow arrives without it, so 4 decimals of agreement is the bar.
    expect(fallback).toBeCloseTo(PAPER_FONT_SCALE, 4);
  });
});

describe('capture stylesheet — micro-labels', () => {
  it('un-wraps and un-truncates the labels for EVERY export style, not just paper', () => {
    // Lifted from `.capture-paper` in round 1: screen exports wrapped
    // "REASONING" onto two lines and clipped "BASH" too.
    const labels = block('.capture-export .role-label-text,');
    expect(labels).toContain('white-space: nowrap');
    expect(labels).toContain('overflow: visible');
    expect(css).toContain('.capture-export .call-label {');
    expect(block('.capture-export .call-label {')).toContain('column-gap: 0.45em');
    // …and the paper-only duplicates are gone (one source of truth).
    expect(css).not.toContain('.capture-paper .call-label {');
  });

  it('floors the paper micro-labels at the style guide 7.5pt minimum', () => {
    const decl = block('.capture-paper .role-label-text,').match(/font-size:\s*([^;]+);/)?.[1] ?? '';
    const size = Number(decl.match(/([\d.]+)px/)?.[1]);
    expect(size).toBeGreaterThan(0);
    expect(finalPt(size)).toBeGreaterThanOrEqual(7.5);
    // The 10px screen size is what fell below it — confirm we actually moved.
    expect(finalPt(10)).toBeLessThan(7.5);
    // …and the authored px must be multiplied by the scale IN THE DECLARATION.
    // Without it the `!important` swallows scaleCard's inline write and the
    // label rasterizes at the authored 11.8px in a 300 DPI space = 2.8pt
    // (the round-2 regression). The general form is the cascade guard below.
    expect(decl).toContain('var(--paper-scale)');
  });

  it('re-derives the micro-label leading from a unitless ratio', () => {
    // scaleCard scaled the INHERITED px leading (16 → ~42px) while the
    // !important font-size stayed put: a dead band ~3.5x the type. A ratio
    // cannot desynchronize from whatever the final font-size turns out to be.
    const lh = block('.capture-paper .role-label-text,').match(/line-height:\s*([^;]+);/)?.[1] ?? '';
    expect(lh).toMatch(/^[\d.]+\s*!important$/);
    expect(Number(parseFloat(lh))).toBeCloseTo(1.3, 2);
  });
});

/**
 * THE CASCADE GUARD.
 *
 * scaleCard (captureImage.ts) enlarges the clone by WRITING INLINE STYLES for
 * font-size, line-height, padding, gap and authored widths. An inline
 * declaration outranks a stylesheet rule — but NOT an `!important` one. So any
 * `.capture-paper` rule that `!important`s one of those properties with a px
 * value silently opts that property out of the ×2.679 the rest of the card
 * gets, and the result is type/space authored for a 96 DPI screen sitting in a
 * 300 DPI figure. That is exactly how the round-1 micro-label fix (11.8px
 * !important → 2.83pt) regressed into a worse defect than it repaired.
 *
 * The invariant, checked over the REAL stylesheet text rather than one
 * hand-picked rule: a `!important` declaration of a scaleCard-owned property
 * may not carry a px length unless it also carries `var(--paper-scale)`.
 * Unitless line-heights and font-relative units (em/ch/%) are exempt — they
 * re-derive from the scaled font-size on their own.
 */
const SCALED_PROPS = [
  'font-size', 'line-height', 'padding', 'padding-top', 'padding-right',
  'padding-bottom', 'padding-left', 'padding-inline', 'padding-inline-start',
  'padding-inline-end', 'padding-block', 'padding-block-start',
  'padding-block-end', 'gap', 'row-gap', 'column-gap', 'width', 'min-width',
  'max-width', 'flex-basis',
];

interface ScaleViolation { selector: string; declaration: string }

/** Every `.capture-paper` declaration that breaks the invariant above. */
function findScaleViolations(cssText: string): ScaleViolation[] {
  // Comments can hold braces-free prose but also property names; strip them so
  // documentation of a bad pattern never trips the guard.
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: ScaleViolation[] = [];
  // Innermost rule blocks (an @supports wrapper never matches — its body has
  // braces — so its inner rules are what get scanned, which is what we want).
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(stripped)) !== null) {
    const selector = m[1].trim();
    if (!selector.includes('.capture-paper')) continue;
    for (const raw of m[2].split(';')) {
      const decl = raw.trim();
      if (!decl || !/!important/.test(decl)) continue;
      const prop = decl.slice(0, decl.indexOf(':')).trim().toLowerCase();
      if (prop.startsWith('--') || !SCALED_PROPS.includes(prop)) continue;
      const value = decl.slice(decl.indexOf(':') + 1);
      if (!/[\d.]+px/.test(value)) continue;               // no px → nothing to desync
      if (value.includes('var(--paper-scale)')) continue;  // scaled: fine
      out.push({ selector, declaration: decl });
    }
  }
  return out;
}

describe('capture stylesheet — cascade guard', () => {
  it('never !importants a scaleCard-owned px value without --paper-scale', () => {
    expect(findScaleViolations(css)).toEqual([]);
  });

  it('has teeth: the guard catches the exact round-2 regression shape', () => {
    // The rule as it shipped in round 1 — the defect this invariant exists for.
    const bad = '.capture-paper .role-label-text { font-size: 11.8px !important; }';
    expect(findScaleViolations(bad)).toHaveLength(1);
    // …while the fixed shape, a unitless leading, an em gap and a ch indent
    // (all of which re-derive from the scaled font) pass.
    const good =
      '.capture-paper .role-label-text { font-size: calc(11.8px * var(--paper-scale)) !important;' +
      ' line-height: 1.3 !important; column-gap: 0.45em !important;' +
      ' padding-left: 2ch !important; margin-inline: 0 !important; }' +
      '.capture-export .x { font-size: 9px !important; }';   // screen style is not scaled
    expect(findScaleViolations(good)).toEqual([]);
  });
});

describe('capture stylesheet — content loss', () => {
  it('pins min-width:0 wherever the export releases the body clip', () => {
    // `overflow: visible` on a grid item re-arms `min-width: auto` =
    // min-content, so ONE long unbreakable token grew the body past the export
    // width and everything beyond it was sliced off the raster silently.
    expect(css).toContain('.capture-export .message-body-clip { overflow: visible !important; }');
    const guard = block('.capture-export .message-body-clip,');
    expect(guard).toContain('min-width: 0');
    expect(guard).toContain('max-width: 100%');
    // The clip, its space-y child and the mono pre — all three are sized by
    // the same rule, so a fix cannot cover one and miss another.
    const selector = css.slice(
      css.indexOf('.capture-export .message-body-clip,'),
      css.indexOf('{', css.indexOf('.capture-export .message-body-clip,')),
    );
    expect(selector).toContain('.message-body-clip > *');
    expect(selector).toContain('pre[data-block-kind="tool"]');
    // Scaled-width safety: neither value is a positive px length, so
    // scaleCard's authoredWidthPx reports null and leaves them alone.
    expect(guard).not.toMatch(/min-width:\s*[\d.]+px/);
  });

  it('wraps the tool-call pre in an export — an image cannot scroll sideways', () => {
    // Bounded + `overflow-x: auto` = a silent clip: a Column export showed the
    // first ~42 characters of 67-character argument lines and dropped the rest
    // mid-glyph. `anywhere` also makes an unbreakable token fold rather than
    // vanish, and is what gives the paper hanging indent something to mark.
    // NB: the same selector also ENDS the min-width group above, so this
    // reads the LAST occurrence — the rule of its own.
    const at = css.lastIndexOf('.capture-export pre[data-block-kind="tool"] {');
    const wrap = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    expect(wrap).toContain('white-space: pre-wrap');
    expect(wrap).toContain('overflow-wrap: anywhere');
    expect(wrap).toContain('overflow-x: visible');
  });
});

describe('capture stylesheet — paper inner gutter', () => {
  it('gives the paper box ONE symmetric 4-6pt gutter, scaled', () => {
    const gutter = block('.capture-paper .message-system-header > div,');
    const px = Number(gutter.match(/padding-inline:\s*calc\(([\d.]+)px/)?.[1]);
    expect(px).toBeGreaterThan(0);
    expect(finalPt(px)).toBeGreaterThanOrEqual(4);
    expect(finalPt(px)).toBeLessThanOrEqual(6);
    expect(gutter).toContain('var(--paper-scale)');
    // The rule must cover the body as well as the header, or the two insets
    // disagree down the card's left edge.
    const selector = css.slice(
      css.indexOf('.capture-paper .message-system-header > div,'),
      css.indexOf('{', css.indexOf('.capture-paper .message-system-header > div,')),
    );
    expect(selector).toContain('.capture-paper .message-body-clip > *');
    // The per-block margins that used to supply the inset are dropped (they
    // are NOT scaled by scaleCard, so they shrank to ~2.9pt at figure size).
    expect(block('.capture-paper .message-body-clip > * > * {')).toContain('margin-inline: 0');
    // …and the reasoning block's extra right padding with them.
    expect(block('.capture-paper [data-block-kind="reasoning"] {')).toContain('padding-right: 0');
  });
});

describe('capture stylesheet — paper body typography', () => {
  it('tightens prose leading to ~1.25 and mono to ~1.30', () => {
    const prose = Number(block('.capture-paper [data-msg-block] {').match(/line-height:\s*([\d.]+)/)?.[1]);
    expect(prose).toBeCloseTo(1.25, 2);
    const mono = Number(
      block('.capture-paper pre[data-block-kind="tool"],').match(/line-height:\s*([\d.]+)/)?.[1],
    );
    expect(mono).toBeCloseTo(1.3, 2);
    // Ratios, not px: scaleCard multiplies computed px, so a px value here
    // would double-scale. Nothing in these two rules may carry a unit.
    expect(block('.capture-paper [data-msg-block] {')).not.toMatch(/line-height:[^;]*px/);
  });

  it('guards the mono hanging indent behind @supports for each-line', () => {
    expect(css).toContain('@supports (text-indent: -2ch each-line)');
    const guardAt = css.indexOf('@supports (text-indent: -2ch each-line)');
    const guarded = css.slice(guardAt, guardAt + 600);
    expect(guarded).toContain('padding-left: 2ch');
    expect(guarded).toContain('text-indent: -2ch each-line');
    // Unguarded, the rule would indent every line BUT the first — worse than
    // no indent at all. The padding must live inside the guard too.
    const unguarded = css.slice(0, guardAt);
    expect(unguarded).not.toContain('padding-left: 2ch');
  });
});

// ---------------------------------------------------------------------------
// Authored font weights stay on the 400/500/600/700 grid.
//
// The vendored Inter is one VARIABLE face; the CDN it replaced served four
// static faces, so off-grid weights (font-[450]) used to snap to 500 and now
// render literally — the TASK card silently got lighter until round 3 of the
// paper-mode critic loop caught it. Any future off-grid weight would repeat
// that class of silent change.
// ---------------------------------------------------------------------------

describe('authored font-weight grid', () => {
  it('every arbitrary Tailwind font-[N] weight in src/ is 400, 500, 600 or 700', () => {
    const allowed = new Set(['400', '500', '600', '700']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(tsx|ts|css)$/.test(entry.name) && !entry.name.includes('.test.')) {
          const src = readFileSync(p, 'utf8');
          for (const m of src.matchAll(/font-\[(\d{3})\]/g)) {
            if (!allowed.has(m[1])) offenders.push(`${p}: font-[${m[1]}]`);
          }
          for (const m of src.matchAll(/font-weight:\s*(\d{3})/g)) {
            if (!allowed.has(m[1])) offenders.push(`${p}: font-weight ${m[1]}`);
          }
        }
      }
    };
    walk(resolve(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
