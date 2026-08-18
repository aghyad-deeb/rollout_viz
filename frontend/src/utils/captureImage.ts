// Presentation Mode image capture — rasterize a message card to a
// publication-quality PNG and copy it to the clipboard.
//
// The card is cloned into an off-screen container at a fixed preset width
// so its text *reflows* to the target width (a paper column, a slide)
// rather than being scaled after the fact. The clone gets the
// `.capture-export` class, which strips on-screen-only chrome and
// normalizes highlights (see index.css). Material Symbols icon glyphs are
// swapped for inline SVG before the snapshot (the ligature icon font does
// not rasterize reliably) so the role / reasoning icons survive the export.

import { domToBlob } from 'modern-screenshot';
import { ELISION_DEFAULT_LABEL } from '../components/RightPanel/ElisionPill';
import { getCaptureFontCss } from './captureFonts';
import type { CaptureStyle, ExportWidth, FontSize } from '../types';

// Ordered export-width presets. Each `px` is the off-screen container width
// the card's text reflows into — so every figure in a deck/paper is
// consistent. This is the single source of truth for the selector in
// ChatView's presentation toolbar and the capture pipeline below.
export interface ExportWidthPreset {
  id: ExportWidth;
  label: string;
  px: number;
}
// `px` is the column width the card's text reflows into (it sets the line
// length / shape); the output is rasterized to a uniform high resolution
// regardless, so a narrow preset is as crisp as a wide one.
export const EXPORT_WIDTH_PRESETS: readonly ExportWidthPreset[] = [
  { id: 'narrow',    label: 'Narrow column',  px: 380 },   // margin figure / callout
  { id: 'paper2',    label: 'Paper 2-column', px: 480 },   // two-column paper figure
  { id: 'paper1',    label: 'Paper 1-column', px: 640 },   // single-column paper figure
  { id: 'half',      label: 'Half slide',     px: 860 },   // side-by-side on a slide
  { id: 'slide',     label: 'Slide',          px: 1280 },  // full 16:9 deck content
  { id: 'slidewide', label: 'Slide (wide)',   px: 1760 },  // full-bleed slide
];

const WIDTH_PX = Object.fromEntries(
  EXPORT_WIDTH_PRESETS.map((p) => [p.id, p.px]),
) as Record<ExportWidth, number>;

// ── Paper figure style ───────────────────────────────────────────────────
// A "Paper" capture is designed at FINAL SIZE, per the project figure style
// guide (environments/eval_envs/paper/figure_style/PLOTTING_STYLE.md): the
// figure is placed in LaTeX at 1:1, never scaled down, so the type in the
// raster must already be body size (8–9pt) at the physical column width.
//
// Rasters have no intrinsic physical size, so we fix one: the paper presets
// are laid out in a 300 DPI coordinate space — 1 inch of final figure = 300
// CSS px in the off-screen container. Everything below follows from that one
// assumption. (The PNG is then rasterized at PAPER_PIXEL_RATIO on top, so the
// delivered file is 600 DPI — supersampled, still 3.25 in / 6.75 in wide when
// placed at its nominal size.)
export const PAPER_DPI = 300;
const PT_PER_INCH = 72;
/** Single-column figure width in the style guide (`ps.COL`). */
const PAPER_COL_IN = 3.25;
/** Full-width figure width in the style guide (`ps.FULL`). */
const PAPER_FULL_IN = 6.75;

export const PAPER_WIDTH_PRESETS: readonly ExportWidthPreset[] = [
  { id: 'col',  label: `Column (${PAPER_COL_IN} in)`,      px: Math.round(PAPER_COL_IN * PAPER_DPI) },   // 975
  { id: 'full', label: `Full width (${PAPER_FULL_IN} in)`, px: Math.round(PAPER_FULL_IN * PAPER_DPI) },  // 2025
];

const PAPER_WIDTH_PX = Object.fromEntries(
  PAPER_WIDTH_PRESETS.map((p) => [p.id, p.px]),
) as Record<ExportWidth, number>;

/** Default paper width: a single column, the common case for a callout. */
const PAPER_DEFAULT_WIDTH: ExportWidth = 'col';

/**
 * The NOMINAL physical width of each paper preset, in PostScript points — the
 * unit a PDF page is measured in (1pt = 1/72 in). This is what makes a paper
 * figure placeable at 1:1 in LaTeX: the PDF page is 234pt (3.25 in) wide and
 * the raster fills it, so `\includegraphics[width=\columnwidth]` neither
 * scales the type nor guesses a DPI.
 *
 *   975 px @300 DPI = 3.25 in = 234 pt
 *  2025 px @300 DPI = 6.75 in = 486 pt
 */
export const PAPER_WIDTH_PT = Object.fromEntries(
  PAPER_WIDTH_PRESETS.map((p) => [p.id, (p.px / PAPER_DPI) * PT_PER_INCH]),
) as Record<ExportWidth, number>;

/**
 * Nominal PDF page width (points) for a (style, width) pair, or `undefined`
 * for the screen style — a screen capture has no physical size, so its PDF
 * page stays 1pt per pixel as it always did.
 */
export function capturePageWidthPt(
  style: CaptureStyle,
  width: ExportWidth,
): number | undefined {
  if (style !== 'paper') return undefined;
  return PAPER_WIDTH_PT[width] ?? PAPER_WIDTH_PT[PAPER_DEFAULT_WIDTH];
}

/**
 * The FINAL PHYSICAL SIZE of a paper capture, in inches — the number the
 * researcher actually needs before placing the figure: the nominal column
 * width is a given, but the height is whatever the card came out to, and a
 * card that runs 12 inches tall will not fit the page it was made for. A
 * pixel count cannot answer that (the raster is 600 DPI supersampled), so the
 * preview states it in inches.
 *
 * `pxWidth` / `pxHeight` are the rendered raster's own dimensions; only their
 * RATIO is used, so the supersampling factor cancels out. Returns null for
 * the screen style (no physical size exists) or before the image has loaded.
 */
export function capturePhysicalSizeIn(
  style: CaptureStyle,
  width: ExportWidth,
  pxWidth: number,
  pxHeight: number,
): { widthIn: number; heightIn: number } | null {
  const pt = capturePageWidthPt(style, width);
  if (!pt || !(pxWidth > 0) || !(pxHeight > 0)) return null;
  const widthIn = pt / PT_PER_INCH;
  return { widthIn, heightIn: (widthIn * pxHeight) / pxWidth };
}

// Target body size for paper figures. The guide's hard rule is "text must end
// up ≈ body font size (8–9pt)"; we aim at the top of that band because the
// transcript's mono blocks sit a notch below the prose (see below).
export const PAPER_BODY_PT = 9;
// The card's prose body size on screen, in CSS px — Tailwind `text-sm`, the
// class MessageCard puts on assistant/user/reasoning bodies. The scale is
// DERIVED from it rather than hardcoded so a future type-scale change to the
// transcript keeps the figure at 9pt.
export const PAPER_BASE_BODY_PX = 14;
/**
 * Multiplier fed to the EXISTING `scaleCard` width-aware scaling.
 *
 *   9pt = 9/72 in = 0.125 in → 0.125 × 300 DPI = 37.5 px at paper scale
 *   37.5 px / 14 px (text-sm) = 2.678571…
 *
 * Mono bodies (`text-[13px]`, tool output / tool-call args) ride the same
 * multiplier and land at 13 × 2.6786 = 34.8 px = 8.36pt — deliberately a
 * notch below the prose, and comfortably above the 7.5pt floor.
 */
export const PAPER_FONT_SCALE =
  ((PAPER_BODY_PT / PT_PER_INCH) * PAPER_DPI) / PAPER_BASE_BODY_PX;

/**
 * White margin between the card's border and the image edge, in paper px.
 * 24 px @300 DPI = 0.08 in ≈ 5.8pt — enough that the 1px rule isn't flush
 * with the crop, small enough that the figure still measures its nominal
 * width edge to edge.
 */
export const PAPER_FRAME_PX = 24;
/** Screen-style frame — unchanged; the pre-paper capture used a flat 16px. */
const SCREEN_FRAME_PX = 16;

/**
 * Supersampling for paper exports: the design space is already 300 DPI, so
 * 2× delivers a 600 DPI file. Fixed (not the screen style's adaptive
 * `2200 / width` ramp) because a paper figure's pixel size must be a
 * predictable multiple of its physical size.
 */
export const PAPER_PIXEL_RATIO = 2;

/** The width presets offered for a given figure style. */
export function captureWidthPresets(style: CaptureStyle): readonly ExportWidthPreset[] {
  return style === 'paper' ? PAPER_WIDTH_PRESETS : EXPORT_WIDTH_PRESETS;
}

/**
 * Off-screen container width (px) for a (style, width) pair. An id from the
 * other style's set — a stale prop, a persisted value from before this
 * feature — falls back to that style's default instead of rendering at 0.
 */
export function resolveCaptureWidthPx(style: CaptureStyle, width: ExportWidth): number {
  if (style === 'paper') return PAPER_WIDTH_PX[width] ?? PAPER_WIDTH_PX[PAPER_DEFAULT_WIDTH];
  return WIDTH_PX[width] ?? 640;
}

/**
 * Font multiplier for a capture. Screen style honors the user's font-size
 * preset; paper style is pinned to the derived final-size scale — the whole
 * point of the mode is that 9pt is not negotiable, so the Font control is
 * shown locked (like the theme control) rather than silently ignored.
 */
export function resolveCaptureFontScale(style: CaptureStyle, fontSize: FontSize): number {
  if (style === 'paper') return PAPER_FONT_SCALE;
  return FONT_SIZE_PRESETS.find((p) => p.id === fontSize)?.scale ?? 1;
}

// Ordered capture font-size presets. `scale` multiplies every font-size in
// the exported image (text reflows bigger at the same render width). Single
// source of truth for the selector in ChatView's presentation toolbar.
export interface FontSizePreset {
  id: FontSize;
  label: string;
  scale: number;
}
export const FONT_SIZE_PRESETS: readonly FontSizePreset[] = [
  { id: 'sm', label: 'Small',   scale: 1.0 },
  { id: 'md', label: 'Medium',  scale: 1.35 },
  { id: 'lg', label: 'Large',   scale: 1.7 },
  { id: 'xl', label: 'X-Large', scale: 2.1 },
];

// Capture-settings persistence. The width / font-size presets a researcher
// picks carry across sessions via localStorage, so every figure keeps the
// same dimensions without re-selecting. (Image theme is deliberately NOT
// persisted — a capture always defaults to light.) An unknown stored value
// falls back to the default preset.
const CAPTURE_WIDTH_KEY = 'rollout_viz_capture_width';
const CAPTURE_FONT_KEY = 'rollout_viz_capture_font';
// Figure style + the paper width, kept in their OWN keys. The screen width
// key above is never written with a paper id (and vice versa), so switching
// to Paper and back restores the exact screen preset the user had.
const CAPTURE_STYLE_KEY = 'rollout_viz_capture_style';
const CAPTURE_PAPER_WIDTH_KEY = 'rollout_viz_capture_paper_width';

export function loadCaptureWidth(): ExportWidth {
  try {
    const saved = localStorage.getItem(CAPTURE_WIDTH_KEY);
    if (saved && EXPORT_WIDTH_PRESETS.some((p) => p.id === saved)) return saved as ExportWidth;
  } catch { /* ignore */ }
  return 'paper1';
}

export function saveCaptureWidth(width: ExportWidth): void {
  try { localStorage.setItem(CAPTURE_WIDTH_KEY, width); } catch { /* ignore */ }
}

export function loadCaptureFontSize(): FontSize {
  try {
    const saved = localStorage.getItem(CAPTURE_FONT_KEY);
    if (saved && FONT_SIZE_PRESETS.some((p) => p.id === saved)) return saved as FontSize;
  } catch { /* ignore */ }
  return 'md';
}

export function saveCaptureFontSize(size: FontSize): void {
  try { localStorage.setItem(CAPTURE_FONT_KEY, size); } catch { /* ignore */ }
}

/** Figure style. Defaults to 'screen' — the pre-paper behavior, always. */
export function loadCaptureStyle(): CaptureStyle {
  try {
    if (localStorage.getItem(CAPTURE_STYLE_KEY) === 'paper') return 'paper';
  } catch { /* ignore */ }
  return 'screen';
}

export function saveCaptureStyle(style: CaptureStyle): void {
  try { localStorage.setItem(CAPTURE_STYLE_KEY, style); } catch { /* ignore */ }
}

export function loadCapturePaperWidth(): ExportWidth {
  try {
    const saved = localStorage.getItem(CAPTURE_PAPER_WIDTH_KEY);
    if (saved && PAPER_WIDTH_PRESETS.some((p) => p.id === saved)) return saved as ExportWidth;
  } catch { /* ignore */ }
  return PAPER_DEFAULT_WIDTH;
}

export function saveCapturePaperWidth(width: ExportWidth): void {
  try { localStorage.setItem(CAPTURE_PAPER_WIDTH_KEY, width); } catch { /* ignore */ }
}

// Page ground behind the card (fills the rounded-corner gaps and the 16px
// frame). This is the transcript tray color, NOT the card paper — a card must
// read as a card sitting on paper, so the two can never be the same value.
// Single source of truth for the container background and the rasterizer's
// backgroundColor. Keep in sync with `--transcript-bg` in src/index.css
// (light `#f6f5f3` / dark `#0e1114`).
//
// `paper` is a third ground, not a third theme: a paper figure sits on the
// page itself, so its frame is the page — pure white, the same value as the
// card (the 1px #444 rule is what makes the box a box there).
export const CAPTURE_PAGE_BG: Record<'light' | 'dark' | 'paper', string> = {
  light: '#f6f5f3',
  dark: '#0e1114',
  paper: '#ffffff',
};

export interface CaptureOptions {
  exportWidth: ExportWidth;
  imageTheme: 'light' | 'dark';
  /** Figure style. Omitted / 'screen' = the app's transcript look. */
  captureStyle?: CaptureStyle;
  /** Multiplies every font-size in the export. 1 = unchanged. */
  fontScale?: number;
  /** Rasterization scale. Omit for the adaptive high-resolution default;
   *  the live left-panel preview passes a lower value for speed. */
  pixelRatio?: number;
}

// The width-ish properties scaleCard rewrites, with their CSS names for the
// Typed OM lookup below.
const SCALED_WIDTH_PROPS = [
  ['width', 'width'],
  ['minWidth', 'min-width'],
  ['maxWidth', 'max-width'],
  ['flexBasis', 'flex-basis'],
] as const;
type ScaledWidthProp = (typeof SCALED_WIDTH_PROPS)[number][0];

/**
 * The px length an element *authors* for a width-ish property, or null when
 * it authored none.
 *
 * `getComputedStyle(el).width` is the RESOLVED (used) value — it reports a px
 * number for every laid-out box, including `auto` and percentage widths. So it
 * cannot be scaled blindly: multiplying the card's own used width would push
 * it past the fixed export column and crop the figure. CSS Typed OM's
 * `computedStyleMap()` reports the COMPUTED value instead, which stays
 * `auto` / `%` / `none` when that is what the author wrote, and absolutizes
 * only real lengths (`7rem` → `112px`) — exactly the discriminator needed.
 * Where Typed OM is unavailable (jsdom, older engines) we fall back to the
 * inline style, which is authored by definition.
 */
export function authoredWidthPx(el: HTMLElement, prop: ScaledWidthProp): number | null {
  const cssName = SCALED_WIDTH_PROPS.find(([js]) => js === prop)?.[1] ?? prop;
  const withMap = el as HTMLElement & { computedStyleMap?: () => Map<string, unknown> };
  if (typeof withMap.computedStyleMap === 'function') {
    try {
      const value = withMap.computedStyleMap().get(cssName) as
        | { value?: unknown; unit?: unknown }
        | undefined;
      if (value && value.unit === 'px' && typeof value.value === 'number' && value.value > 0) {
        return value.value;
      }
      return null;
    } catch { /* fall through to the inline-style path */ }
  }
  const inline = el.style[prop];
  const n = parseFloat(inline);
  return inline.endsWith('px') && n > 0 ? n : null;
}

// Enlarge the card in the off-screen clone before rasterizing. Multiplies
// every element's font-size, line-height, padding, gap AND authored fixed
// widths by `factor` in a single measure-then-write pass — so the capture is
// a faithful scaled-up replica (the header bar and chrome scale with the body
// text), not just bigger text inside fixed-size boxes. Measured first so an
// em-based cascade isn't compounded.
//
// Widths matter because they are NOT font-relative: at fontScale > 1 the
// `w-28` header gutter used to clip the role label ("BASH" → "BASI") and the
// `w-10` line badge squeezed the meta run. `width` is only rewritten on boxes
// that declare `flex-shrink: 0` — the layout's own marker for "this is a
// fixed box" — so an auto-width container can never be frozen at a scaled
// used value. `min/max-width` and `flex-basis` need no such guard: their
// computed value is a keyword unless a length was authored.
// Exported for the unit test that pins the width-rewriting contract.
export function scaleCard(root: HTMLElement, factor: number): void {
  if (factor === 1) return;
  const els: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  const scalePx = (v: string): string | null => {
    const n = parseFloat(v);
    return v.endsWith('px') && n > 0 ? `${n * factor}px` : null;
  };
  const measured = els.map((el) => {
    const cs = getComputedStyle(el);
    return {
      fontSize: parseFloat(cs.fontSize) || 0,
      lineHeight: cs.lineHeight,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
      gap: [cs.rowGap, cs.columnGap],
      isFixedBox: cs.flexShrink === '0',
      widths: {
        width: authoredWidthPx(el, 'width'),
        minWidth: authoredWidthPx(el, 'minWidth'),
        maxWidth: authoredWidthPx(el, 'maxWidth'),
        flexBasis: authoredWidthPx(el, 'flexBasis'),
      },
    };
  });
  els.forEach((el, i) => {
    const m = measured[i];
    if (m.fontSize > 0) el.style.fontSize = `${m.fontSize * factor}px`;
    if (m.lineHeight.endsWith('px')) el.style.lineHeight = `${parseFloat(m.lineHeight) * factor}px`;
    const [pt, pr, pb, pl] = m.padding.map(scalePx);
    if (pt) el.style.paddingTop = pt;
    if (pr) el.style.paddingRight = pr;
    if (pb) el.style.paddingBottom = pb;
    if (pl) el.style.paddingLeft = pl;
    const [rg, cg] = m.gap.map(scalePx);
    if (rg) el.style.rowGap = rg;
    if (cg) el.style.columnGap = cg;
    // `width` only on declared fixed boxes (see the note above); the other
    // three are safe wherever they were authored. `el !== root` protects the
    // clone's own `width:100%`, which the caller sets deliberately.
    if (el !== root) {
      if (m.isFixedBox && m.widths.width != null) el.style.width = `${m.widths.width * factor}px`;
      if (m.widths.minWidth != null) el.style.minWidth = `${m.widths.minWidth * factor}px`;
      if (m.widths.maxWidth != null) el.style.maxWidth = `${m.widths.maxWidth * factor}px`;
      if (m.widths.flexBasis != null) el.style.flexBasis = `${m.widths.flexBasis * factor}px`;
    }
  });
}

// Material Symbols icon glyphs are ligature-based and do not rasterize
// reliably through the capture. Before snapshotting, each kept icon span's
// text is swapped for an inline <svg> of the same icon (SVG rasterizes
// perfectly). Paths are Material Symbols, viewBox `0 -960 960 960`.
const SVG_NS = 'http://www.w3.org/2000/svg';
export const CAPTURE_ICON_PATHS: Record<string, string> = {
  contextual_token: 'M244-325h266v-102H244v102Zm370 0h102v-309H614v309ZM244-532h266v-102H244v102ZM140-160q-24 0-42-18t-18-42v-520q0-24 18-42t42-18h680q24 0 42 18t18 42v520q0 24-18 42t-42 18H140Zm0-60h680v-520H140v520Zm0 0v-520 520Z',
  description: 'M320-240h320v-60H320v60Zm0-160h320v-60H320v60ZM220-80q-24 0-42-18t-18-42v-680q0-24 18-42t42-18h360l220 220v520q0 24-18 42t-42 18H220Zm330-550v-190H220v680h520v-490H550ZM220-820v680-680 190-190Z',
  person: 'M372-523q-42-42-42-108t42-108q42-42 108-42t108 42q42 42 42 108t-42 108q-42 42-108 42t-108-42ZM160-160v-94q0-38 19-65t49-41q67-30 128.5-45T480-420q62 0 123 15.5T731-360q31 14 50 41t19 65v94H160Zm60-60h520v-34q0-16-9.5-30.5T707-306q-64-31-117-42.5T480-360q-57 0-111 11.5T252-306q-14 7-23 21.5t-9 30.5v34Zm324.5-346.5Q570-592 570-631t-25.5-64.5Q519-721 480-721t-64.5 25.5Q390-670 390-631t25.5 64.5Q441-541 480-541t64.5-25.5ZM480-631Zm0 411Z',
  network_intelligence: 'M317-160q-8 0-15-4t-11-11l-84-150h71l42 80h90v-30h-72l-42-80H191l-63-110q-2-4-3-7.5t-1-7.5q0-2 4-15l63-110h105l42-80h72v-30h-90l-42 80h-71l84-150q4-7 11-11t15-4h118q13 0 21.5 8.5T465-770v175h-85l-30 30h115v130h-98l-39-80h-98l-30 30h108l40 80h117v215q0 13-8.5 21.5T435-160H317Zm208 0q-13 0-21.5-8.5T495-190v-215h117l40-80h108l-30-30h-98l-39 80h-98v-130h115l-30-30h-85v-175q0-13 8.5-21.5T525-800h118q8 0 15 4t11 11l84 150h-71l-42-80h-90v30h72l42 80h105l63 110q2 4 3 7.5t1 7.5q0 2-4 15l-63 110H664l-42 80h-72v30h90l42-80h71l-84 150q-4 7-11 11t-15 4H525Z',
  build: 'M705-128 447-388q-23 8-46 13t-47 5q-97.08 0-165.04-67.67Q121-505.33 121-602q0-31 8.16-60.39T152-718l145 145 92-86-149-149q25.91-15.16 54.96-23.58Q324-840 354-840q99.17 0 168.58 69.42Q592-701.17 592-602q0 24-5 47t-13 46l259 258q11 10.96 11 26.48T833-198l-76 70q-10.7 11-25.85 11Q716-117 705-128Zm28-57 40-40-273-273q16-21 24-49.5t8-54.5q0-75-55.5-127T350-782l102 104q9 9 8.5 21.5T451-635L318-510q-9.27 8-21.64 8-12.36 0-20.36-8l-98-97q3 77 54.67 127T354-430q25 0 53-8t49-24l277 277ZM476-484Z',
  code: 'M320-242 80-482l242-242 43 43-199 199 197 197-43 43Zm318 2-43-43 199-199-197-197 43-43 240 240-242 242Z',
  lightbulb: 'M422.5-103.5Q399-127 399-161h162q0 34-23.5 57.5T480-80q-34 0-57.5-23.5ZM318-223v-60h324v60H318Zm5-121q-66-43-104.5-107.5T180-597q0-122 89-211t211-89q122 0 211 89t89 211q0 81-38 145.5T637-344H323Zm22-60h271q48-32 76-83t28-110q0-99-70.5-169.5T480-837q-99 0-169.5 70.5T240-597q0 59 28 110t77 83Zm135 0Z',
  terminal: 'M140-160q-24 0-42-18t-18-42v-520q0-24 18-42t42-18h680q24 0 42 18t18 42v520q0 24-18 42t-42 18H140Zm0-60h680v-436H140v436Zm160-72-42-42 103-104-104-104 43-42 146 146-146 146Zm190 4v-60h220v60H490Z',
};

// Swap every Material Symbols span in the clone for an inline SVG of the
// same icon. Runs after scaleCard so the SVG is sized to the final
// font-size. Unmapped icons (e.g. action-button chrome, dropped anyway by
// the snapshot filter) are just blanked so no ligature name renders.
function inlineIcons(root: HTMLElement): void {
  const spans = Array.from(root.querySelectorAll<HTMLElement>('.material-symbols-outlined'));
  for (const span of spans) {
    const name = (span.textContent || '').trim();
    span.textContent = '';
    const d = CAPTURE_ICON_PATHS[name];
    if (!d) continue;
    const size = parseFloat(getComputedStyle(span).fontSize) || 20;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.style.display = 'inline-block';
    svg.style.verticalAlign = 'middle';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    span.appendChild(svg);
  }
}

/**
 * The one DOM edit the paper style needs that CSS cannot express: the
 * elision pill's default label is the three ASCII dots `...` (ElisionPill
 * renders `[{display}]`), and the figure style guide asks for `[…]` — a
 * bracketed ELLIPSIS glyph (U+2026) — for every elision. A user-typed label
 * is left exactly as written.
 *
 * The default label is IMPORTED from ElisionPill rather than re-typed here:
 * these two must agree or the rewrite silently stops matching.
 *
 * Exported for the unit test that pins the glyph.
 */
export const PAPER_ELLIPSIS = '[…]';
const PAPER_ELLIPSIS_SOURCE = `[${ELISION_DEFAULT_LABEL}]`;
export function paperizeClone(root: HTMLElement): void {
  for (const pill of Array.from(root.querySelectorAll<HTMLElement>('.elision-pill'))) {
    if (pill.textContent?.trim() === PAPER_ELLIPSIS_SOURCE) pill.textContent = PAPER_ELLIPSIS;
  }
}

/**
 * Capture a message-card element as a PNG Blob. Does not embed metadata or
 * touch the clipboard — callers compose `addPngTextChunk` +
 * `copyImageToClipboard` around this.
 */
export async function captureCardToPng(
  cardEl: HTMLElement,
  opts: CaptureOptions,
): Promise<Blob> {
  // The single branch point between the two figure styles. Everything the
  // paper style changes is either derived here or lives in `.capture-paper`
  // (index.css) — the screen path below is untouched.
  const isPaper = opts.captureStyle === 'paper';
  const width = resolveCaptureWidthPx(isPaper ? 'paper' : 'screen', opts.exportWidth);
  // Paper always renders LIGHT: a figure sits on the printed page.
  const bg = isPaper ? CAPTURE_PAGE_BG.paper : CAPTURE_PAGE_BG[opts.imageTheme];
  const frame = isPaper ? PAPER_FRAME_PX : SCREEN_FRAME_PX;
  const fontScale = opts.fontScale ?? 1;
  // Render every width preset to roughly the same high absolute resolution
  // (~2200px wide) so a narrow preset is just as crisp as a wide one. The
  // scale is clamped: a wide preset still supersamples at >=2x, a narrow one
  // doesn't blow past the canvas-size limit. An explicit pixelRatio (the
  // live left-panel preview passes a lower one for speed) overrides this.
  // Paper opts out of the ramp: its design space is already 300 DPI, so a
  // fixed 2x keeps the output a predictable 600 DPI at the nominal width.
  const scale = opts.pixelRatio
    ?? (isPaper ? PAPER_PIXEL_RATIO : Math.min(6, Math.max(2, 2200 / width)));

  // Off-screen, fixed-width container. Kept inside <body> so the clone
  // inherits every stylesheet and the document's `.dark` class.
  const container = document.createElement('div');
  container.style.cssText =
    `position:fixed;left:-99999px;top:0;width:${width}px;` +
    `padding:${frame}px;background:${bg};box-sizing:border-box;pointer-events:none;`;
  // Carry the image theme on the container. With `.dark` on #root (not
  // <html>), this <body>-level container escapes the app theme — so the
  // capture can be light even when the UI is dark, and vice versa.
  if (opts.imageTheme === 'dark' && !isPaper) container.classList.add('dark');

  const clone = cardEl.cloneNode(true) as HTMLElement;
  clone.classList.add('capture-export');
  // `.capture-paper` layers ON TOP of `.capture-export` (never replaces it):
  // the export class still strips chrome and forces the body open, the paper
  // class re-grounds the surviving card as an ink-on-white figure box.
  if (isPaper) {
    clone.classList.add('capture-paper');
    // The paper rule weights are the screen design's weights carried across
    // the SAME multiplier the type uses (see `.capture-paper` in index.css,
    // which expresses each as `calc(<screen px> * var(--paper-scale))`).
    // Borders are not touched by scaleCard — only this var keeps them in
    // step with the font scale, from one number.
    clone.style.setProperty('--paper-scale', String(PAPER_FONT_SCALE));
    paperizeClone(clone);
  }
  clone.style.width = '100%';
  clone.style.margin = '0';
  container.appendChild(clone);
  document.body.appendChild(container);
  scaleCard(clone, fontScale);
  inlineIcons(clone);

  try {
    // Fonts must be loaded or text rasterizes with fallback glyphs.
    if (document.fonts?.ready) {
      try { await document.fonts.ready; } catch { /* ignore */ }
    }
    // …and they must travel INSIDE the snapshot: the rasterizer serializes the
    // clone into an SVG <foreignObject> where the page's @font-face rules no
    // longer apply. `fontCss` is the self-hosted woff2 set inlined as base64
    // (utils/captureFonts.ts, built once per page load). Without it every
    // export rendered in the rasterizer's fallback face.
    const fontCss = await getCaptureFontCss();
    // Two frames for layout to settle at the new width.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const blob = await domToBlob(container, {
      type: 'image/png',
      scale,
      backgroundColor: bg,
      maximumCanvasSize: 16384,
      // `cssText` REPLACES modern-screenshot's own font discovery, so the
      // embed is deterministic. Omitted (default discovery) if the fetch
      // failed, which degrades to the pre-fix behavior rather than failing.
      ...(fontCss ? { font: { cssText: fontCss } } : {}),
      // Drop interaction-only chrome. Material Symbols spans are kept — their
      // glyphs were swapped for inline SVG above (inlineIcons) so they
      // rasterize cleanly.
      filter: (el: Node) => {
        if (!(el instanceof Element)) return true;
        if (el.classList.contains('presentation-chrome')) return false;
        return true;
      },
    });
    if (!blob) throw new Error('capture produced no image');
    return blob;
  } finally {
    container.remove();
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type DownloadFormat = 'png' | 'jpeg' | 'webp' | 'pdf';

/**
 * Deflate bytes into a zlib stream (what PDF's /FlateDecode expects).
 * Falls back to the raw bytes (and no filter) where CompressionStream is
 * unavailable — a bigger but still valid, still LOSSLESS, PDF.
 */
async function flate(bytes: Uint8Array): Promise<{ data: Uint8Array; filter: string }> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream })
    .CompressionStream;
  if (typeof CS !== 'function') return { data: bytes, filter: '' };
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS('deflate'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return { data: packed, filter: '/Filter /FlateDecode ' };
  } catch {
    return { data: bytes, filter: '' };
  }
}

/** PDF numbers: integers stay integers so `/MediaBox [0 0 234 …]` reads exactly. */
function pdfNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Page geometry for an image of `width` x `height` PIXELS.
 *
 * `pageWidthPt` is the figure's NOMINAL physical width in points (paper style:
 * 234pt = 3.25 in for a column, 486pt for full width). The height follows the
 * pixel aspect ratio, so the raster fills the page at exactly its intended
 * physical size and LaTeX places it 1:1 with no scaling. Omitted (screen
 * style) the page falls back to 1pt per pixel, the pre-existing behavior.
 *
 * Exported for the unit test that pins the 234/486pt math.
 */
export function pdfPageSizePt(
  width: number,
  height: number,
  pageWidthPt?: number,
): { widthPt: number; heightPt: number } {
  if (!pageWidthPt || width <= 0) return { widthPt: Math.round(width), heightPt: Math.round(height) };
  return { widthPt: pageWidthPt, heightPt: (pageWidthPt * height) / width };
}

/**
 * Wrap a raster in a minimal, single-page PDF (dependency-free).
 *
 * `rgb` is RAW, INTERLEAVED 8-bit RGB (3 bytes per pixel) — deliberately not a
 * JPEG: a figure that goes into a paper must not carry DCT ringing around the
 * type. The stream is deflated (/FlateDecode), which is lossless.
 */
export async function imageToPdf(
  rgb: Uint8Array,
  width: number,
  height: number,
  pageWidthPt?: number,
): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const put = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const startObject = (header: string) => {
    offsets.push(length);
    put(header);
  };

  const w = Math.round(width);
  const h = Math.round(height);
  // The page is measured in POINTS; the image XObject stays in pixels and is
  // stretched over the whole page by the `cm` matrix.
  const { widthPt, heightPt } = pdfPageSizePt(w, h, pageWidthPt);
  const pw = pdfNum(widthPt);
  const ph = pdfNum(heightPt);
  const content = `q\n${pw} 0 0 ${ph} 0 0 cm\n/Im0 Do\nQ\n`;
  const { data: stream, filter } = await flate(rgb);

  put('%PDF-1.3\n');
  startObject('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObject('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  startObject(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}]` +
      ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );
  startObject(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h}` +
      ` /ColorSpace /DeviceRGB /BitsPerComponent 8 ${filter}` +
      `/Length ${stream.length} >>\nstream\n`,
  );
  put(stream);
  put('\nendstream\nendobj\n');
  startObject(
    `5 0 obj\n<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`,
  );

  const xrefOffset = length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  put(xref);
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return new Blob([out], { type: 'application/pdf' });
}

/**
 * Re-encode a capture image Blob to the requested download format. PNG is
 * returned untouched; jpeg / webp / pdf are re-encoded via a canvas (jpeg
 * and pdf get a white matte since they have no alpha channel).
 *
 * `pageWidthPt` (paper style only, from `capturePageWidthPt`) gives the PDF
 * page its nominal physical width in points.
 */
export async function encodeImage(
  src: Blob,
  format: DownloadFormat,
  pageWidthPt?: number,
): Promise<Blob> {
  if (format === 'png') return src;
  const bitmap = await createImageBitmap(src);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return src;
    // jpeg and pdf are opaque formats — paint a white matte first.
    if (format === 'jpeg' || format === 'pdf') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    if (format === 'pdf') {
      // Raw RGB, not a re-encoded JPEG: the PDF stream is lossless, so the
      // type in a figure has no DCT ringing around it.
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const rgb = new Uint8Array((data.length / 4) * 3);
      for (let i = 0, j = 0; i < data.length; i += 4) {
        rgb[j++] = data[i];
        rgb[j++] = data[i + 1];
        rgb[j++] = data[i + 2];
      }
      return await imageToPdf(rgb, canvas.width, canvas.height, pageWidthPt);
    }
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b ?? src), `image/${format}`, 0.95);
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Copy a PNG to the clipboard. `caption` (if non-empty) is attached as a
 * `text/plain` part of the same clipboard item, so pasting into a text
 * field yields the citation while pasting into a doc yields the image.
 * Returns true on a real clipboard write; on failure it falls back to
 * downloading the PNG (metadata preserved, saved as `fallbackFilename`) and
 * returns false.
 *
 * Call this straight from the click handler with the Blob already in hand:
 * `navigator.clipboard.write` must run inside the user-gesture activation,
 * so an intervening `await` (e.g. fetching the image) can make it fail.
 */
export async function copyImageToClipboard(
  pngBlob: Blob,
  caption: string,
  fallbackFilename = 'rollout-capture.png',
): Promise<boolean> {
  try {
    const parts: Record<string, Blob> = { 'image/png': pngBlob };
    if (caption) {
      parts['text/plain'] = new Blob([caption], { type: 'text/plain' });
    }
    await navigator.clipboard.write([new ClipboardItem(parts)]);
    return true;
  } catch {
    downloadBlob(pngBlob, fallbackFilename);
    return false;
  }
}
