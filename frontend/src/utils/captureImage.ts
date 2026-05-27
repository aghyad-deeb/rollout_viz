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
import type { ExportWidth, FontSize } from '../types';

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

// Page background behind the card (fills the rounded-corner gaps).
const PAGE_BG: Record<'light' | 'dark', string> = {
  light: '#ffffff',
  dark: '#1a1a2e',
};

export interface CaptureOptions {
  exportWidth: ExportWidth;
  imageTheme: 'light' | 'dark';
  /** Multiplies every font-size in the export. 1 = unchanged. */
  fontScale?: number;
  /** Rasterization scale. Omit for the adaptive high-resolution default;
   *  the live left-panel preview passes a lower value for speed. */
  pixelRatio?: number;
}

// Enlarge the card in the off-screen clone before rasterizing. Multiplies
// every element's font-size, line-height, padding and gap by `factor` in a
// single measure-then-write pass — so the capture is a faithful scaled-up
// replica (the header bar and chrome scale with the body text), not just
// bigger text inside fixed-size boxes. Measured first so an em-based
// cascade isn't compounded.
function scaleCard(root: HTMLElement, factor: number): void {
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
  });
}

// Material Symbols icon glyphs are ligature-based and do not rasterize
// reliably through the capture. Before snapshotting, each kept icon span's
// text is swapped for an inline <svg> of the same icon (SVG rasterizes
// perfectly). Paths are Material Symbols, viewBox `0 -960 960 960`.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS: Record<string, string> = {
  contextual_token: 'M244-325h266v-102H244v102Zm370 0h102v-309H614v309ZM244-532h266v-102H244v102ZM140-160q-24 0-42-18t-18-42v-520q0-24 18-42t42-18h680q24 0 42 18t18 42v520q0 24-18 42t-42 18H140Zm0-60h680v-520H140v520Zm0 0v-520 520Z',
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
    const d = ICON_PATHS[name];
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
 * Capture a message-card element as a PNG Blob. Does not embed metadata or
 * touch the clipboard — callers compose `addPngTextChunk` +
 * `copyImageToClipboard` around this.
 */
export async function captureCardToPng(
  cardEl: HTMLElement,
  opts: CaptureOptions,
): Promise<Blob> {
  const width = WIDTH_PX[opts.exportWidth] ?? 640;
  const bg = PAGE_BG[opts.imageTheme];
  const fontScale = opts.fontScale ?? 1;
  // Render every width preset to roughly the same high absolute resolution
  // (~2200px wide) so a narrow preset is just as crisp as a wide one. The
  // scale is clamped: a wide preset still supersamples at >=2x, a narrow one
  // doesn't blow past the canvas-size limit. An explicit pixelRatio (the
  // live left-panel preview passes a lower one for speed) overrides this.
  const scale = opts.pixelRatio ?? Math.min(6, Math.max(2, 2200 / width));

  // Off-screen, fixed-width container. Kept inside <body> so the clone
  // inherits every stylesheet and the document's `.dark` class.
  const container = document.createElement('div');
  container.style.cssText =
    `position:fixed;left:-99999px;top:0;width:${width}px;` +
    `padding:16px;background:${bg};box-sizing:border-box;pointer-events:none;`;
  // Carry the image theme on the container. With `.dark` on #root (not
  // <html>), this <body>-level container escapes the app theme — so the
  // capture can be light even when the UI is dark, and vice versa.
  if (opts.imageTheme === 'dark') container.classList.add('dark');

  const clone = cardEl.cloneNode(true) as HTMLElement;
  clone.classList.add('capture-export');
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
    // Two frames for layout to settle at the new width.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const blob = await domToBlob(container, {
      type: 'image/png',
      scale,
      backgroundColor: bg,
      maximumCanvasSize: 16384,
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
 * Wrap a baseline-JPEG image in a minimal, single-page PDF (dependency-free).
 * The page is sized to the image and the JPEG is embedded directly via the
 * DCTDecode filter. Used for the "PDF" download format.
 */
export function imageToPdf(jpeg: Uint8Array, width: number, height: number): Blob {
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
  const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;

  put('%PDF-1.3\n');
  startObject('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObject('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  startObject(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]` +
      ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );
  startObject(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h}` +
      ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode` +
      ` /Length ${jpeg.length} >>\nstream\n`,
  );
  put(jpeg);
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
 */
export async function encodeImage(src: Blob, format: DownloadFormat): Promise<Blob> {
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
      const jpeg = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('jpeg encode failed'))),
          'image/jpeg',
          0.95,
        );
      });
      return imageToPdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height);
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
 * downloading the PNG (metadata preserved) and returns false.
 *
 * Call this straight from the click handler with the Blob already in hand:
 * `navigator.clipboard.write` must run inside the user-gesture activation,
 * so an intervening `await` (e.g. fetching the image) can make it fail.
 */
export async function copyImageToClipboard(pngBlob: Blob, caption: string): Promise<boolean> {
  try {
    const parts: Record<string, Blob> = { 'image/png': pngBlob };
    if (caption) {
      parts['text/plain'] = new Blob([caption], { type: 'text/plain' });
    }
    await navigator.clipboard.write([new ClipboardItem(parts)]);
    return true;
  } catch {
    downloadBlob(pngBlob, 'rollout-capture.png');
    return false;
  }
}
