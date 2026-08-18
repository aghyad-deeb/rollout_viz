// The rasterizer is stubbed so `captureCardToPng` can be driven in jsdom:
// the mock records the off-screen container it was handed (class list,
// width, frame) — which IS the contract the figure styles differ on.
const shot = vi.hoisted(() => ({
  calls: [] as {
    containerClasses: string[];
    cloneClasses: string[];
    width: string;
    padding: string;
    html: string;
    backgroundColor: string;
    scale: number;
    paperScale: string;
    fontCss: string | undefined;
  }[],
}));
vi.mock('modern-screenshot', () => ({
  domToBlob: vi.fn(async (
    node: HTMLElement,
    opts: { backgroundColor: string; scale: number; font?: { cssText?: string } },
  ) => {
    const clone = node.firstElementChild as HTMLElement;
    shot.calls.push({
      containerClasses: Array.from(node.classList),
      cloneClasses: Array.from(clone.classList),
      width: node.style.width,
      padding: node.style.padding,
      html: node.innerHTML,
      backgroundColor: opts.backgroundColor,
      scale: opts.scale,
      paperScale: clone.style.getPropertyValue('--paper-scale'),
      fontCss: opts.font?.cssText,
    });
    return new Blob(['png'], { type: 'image/png' });
  }),
}));

import {
  CAPTURE_ICON_PATHS,
  CAPTURE_PAGE_BG,
  EXPORT_WIDTH_PRESETS,
  PAPER_BASE_BODY_PX,
  PAPER_BODY_PT,
  PAPER_DPI,
  PAPER_ELLIPSIS,
  PAPER_FONT_SCALE,
  PAPER_FRAME_PX,
  PAPER_PIXEL_RATIO,
  PAPER_WIDTH_PRESETS,
  PAPER_WIDTH_PT,
  authoredWidthPx,
  capturePageWidthPt,
  capturePhysicalSizeIn,
  captureCardToPng,
  captureWidthPresets,
  imageToPdf,
  loadCaptureWidth,
  saveCaptureWidth,
  loadCaptureFontSize,
  saveCaptureFontSize,
  loadCaptureStyle,
  saveCaptureStyle,
  loadCapturePaperWidth,
  saveCapturePaperWidth,
  paperizeClone,
  pdfPageSizePt,
  resolveCaptureFontScale,
  resolveCaptureWidthPx,
  scaleCard,
} from './captureImage';
import { blobToBytes } from './pngMetadata';
import { _resetCaptureFontCache } from './captureFonts';

// imageToPdf treats the image payload as opaque bytes, so a stub is fine.
// (Raw interleaved RGB now, not a JPEG — the stream is lossless.)
const fakeRgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);

describe('capture icon paths', () => {
  it('includes the file role icon used by presentation captures', () => {
    expect(CAPTURE_ICON_PATHS.description).toBeTruthy();
  });
});

describe('capture page frame', () => {
  it('grounds the page in the transcript tray, never the card paper', () => {
    // A card must read as a card sitting on paper: the frame color can never
    // equal --card-paper (#ffffff light / #16191d dark).
    expect(CAPTURE_PAGE_BG.light).toBe('#f6f5f3');
    expect(CAPTURE_PAGE_BG.dark).toBe('#0e1114');
    expect(CAPTURE_PAGE_BG.light).not.toBe('#ffffff');
    expect(CAPTURE_PAGE_BG.dark).not.toBe('#1a1a2e');
  });

  it('adds a paper ground of pure white — a figure sits on the page itself', () => {
    expect(CAPTURE_PAGE_BG.paper).toBe('#ffffff');
  });
});

// ---------------------------------------------------------------------------
// Paper figure style — final-size geometry
// ---------------------------------------------------------------------------

describe('paper figure geometry', () => {
  it('lays the two paper presets out at 300 DPI: 3.25 in = 975 px, 6.75 in = 2025 px', () => {
    expect(PAPER_DPI).toBe(300);
    expect(PAPER_WIDTH_PRESETS.map((p) => p.id)).toEqual(['col', 'full']);
    expect(PAPER_WIDTH_PRESETS.map((p) => p.px)).toEqual([975, 2025]);
    expect(PAPER_WIDTH_PRESETS[0].px / PAPER_DPI).toBe(3.25);
    expect(PAPER_WIDTH_PRESETS[1].px / PAPER_DPI).toBe(6.75);
  });

  it('derives a font scale that lands body text at exactly 9pt', () => {
    // 9pt = 0.125 in → 37.5 px at 300 DPI; over the 14px `text-sm` body.
    expect(PAPER_FONT_SCALE).toBeCloseTo(37.5 / PAPER_BASE_BODY_PX, 12);
    expect(PAPER_FONT_SCALE).toBeCloseTo(2.678571, 5);
    const bodyPt = ((PAPER_BASE_BODY_PX * PAPER_FONT_SCALE) / PAPER_DPI) * 72;
    expect(bodyPt).toBeCloseTo(PAPER_BODY_PT, 10);
    expect(bodyPt).toBeGreaterThanOrEqual(8);   // style guide: 8–9pt at final size
    expect(bodyPt).toBeLessThanOrEqual(9);
  });

  it('keeps the 13px mono bodies above the 7.5pt floor', () => {
    const monoPt = ((13 * PAPER_FONT_SCALE) / PAPER_DPI) * 72;
    expect(monoPt).toBeCloseTo(8.357, 3);
    expect(monoPt).toBeGreaterThanOrEqual(7.5);
    expect(monoPt).toBeLessThan(PAPER_BODY_PT);  // mono may sit slightly smaller
  });

  it('serves each style its own width presets, leaving the screen list untouched', () => {
    expect(captureWidthPresets('screen')).toBe(EXPORT_WIDTH_PRESETS);
    expect(captureWidthPresets('paper')).toBe(PAPER_WIDTH_PRESETS);
    expect(EXPORT_WIDTH_PRESETS.map((p) => p.id)).toEqual([
      'narrow', 'paper2', 'paper1', 'half', 'slide', 'slidewide',
    ]);
  });

  it('resolves widths per style and falls back within the style on a foreign id', () => {
    expect(resolveCaptureWidthPx('paper', 'col')).toBe(975);
    expect(resolveCaptureWidthPx('paper', 'full')).toBe(2025);
    expect(resolveCaptureWidthPx('screen', 'paper1')).toBe(640);
    expect(resolveCaptureWidthPx('screen', 'slidewide')).toBe(1760);
    // A width belonging to the other style never renders at 0.
    expect(resolveCaptureWidthPx('paper', 'paper1')).toBe(975);
    expect(resolveCaptureWidthPx('screen', 'col')).toBe(640);
  });

  it('pins the paper font scale and honors the preset on screen', () => {
    expect(resolveCaptureFontScale('paper', 'sm')).toBe(PAPER_FONT_SCALE);
    expect(resolveCaptureFontScale('paper', 'xl')).toBe(PAPER_FONT_SCALE);
    expect(resolveCaptureFontScale('screen', 'sm')).toBe(1);
    expect(resolveCaptureFontScale('screen', 'md')).toBe(1.35);
    expect(resolveCaptureFontScale('screen', 'xl')).toBe(2.1);
  });
});

describe('paperizeClone', () => {
  function pill(text: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `<span class="elision-pill">${text}</span>`;
    return root;
  }

  it('flattens the default [...] to a bracketed ellipsis GLYPH, not three dots', () => {
    const root = pill('[...]');
    paperizeClone(root);
    const out = root.querySelector('.elision-pill')!.textContent!;
    expect(out).toBe(PAPER_ELLIPSIS);
    expect(out).toBe('[…]');
    expect(out).toHaveLength(3);
    expect(out.charCodeAt(1)).toBe(0x2026);
    expect(out).not.toContain('...');
  });

  it('leaves a user-typed elision label alone', () => {
    const root = pill('[12 lines of setup]');
    paperizeClone(root);
    expect(root.querySelector('.elision-pill')!.textContent).toBe('[12 lines of setup]');
  });
});

// ---------------------------------------------------------------------------
// captureCardToPng — the style branch point
// ---------------------------------------------------------------------------

describe('captureCardToPng figure styles', () => {
  beforeEach(() => { shot.calls.length = 0; });

  function card(): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML =
      '<div class="message-assistant"><span class="elision-pill">[...]</span></div>';
    document.body.appendChild(el);
    return el;
  }

  it('paper: adds .capture-paper beside .capture-export, at the paper width/ground', async () => {
    await captureCardToPng(card(), { exportWidth: 'col', imageTheme: 'dark', captureStyle: 'paper' });

    const c = shot.calls[0];
    expect(c.cloneClasses).toContain('capture-export');
    expect(c.cloneClasses).toContain('capture-paper');
    expect(c.width).toBe('975px');
    expect(c.padding).toBe(`${PAPER_FRAME_PX}px`);
    expect(c.backgroundColor).toBe('#ffffff');
    expect(c.scale).toBe(PAPER_PIXEL_RATIO);
    expect(c.scale).toBeGreaterThanOrEqual(2);
    // Paper renders light even when the app / image theme is dark.
    expect(c.containerClasses).not.toContain('dark');
    // …and the elision reads as a typographic ellipsis.
    expect(c.html).toContain('[…]');
  });

  it('paper: the full-width preset renders 2025px wide', async () => {
    await captureCardToPng(card(), { exportWidth: 'full', imageTheme: 'light', captureStyle: 'paper' });
    expect(shot.calls[0].width).toBe('2025px');
  });

  it('screen (default): no .capture-paper, and the pre-paper width/frame/scale', async () => {
    await captureCardToPng(card(), { exportWidth: 'paper1', imageTheme: 'light' });

    const c = shot.calls[0];
    expect(c.cloneClasses).toContain('capture-export');
    expect(c.cloneClasses).not.toContain('capture-paper');
    expect(c.width).toBe('640px');
    expect(c.padding).toBe('16px');
    expect(c.backgroundColor).toBe('#f6f5f3');
    expect(c.scale).toBe(2200 / 640);
    expect(c.html).toContain('[...]');    // no paper glyph rewrite
  });

  it('screen: an explicit dark image theme still darkens the container', async () => {
    await captureCardToPng(card(), { exportWidth: 'slide', imageTheme: 'dark', captureStyle: 'screen' });

    const c = shot.calls[0];
    expect(c.containerClasses).toContain('dark');
    expect(c.backgroundColor).toBe('#0e1114');
    expect(c.cloneClasses).not.toContain('capture-paper');
  });
});

describe('authoredWidthPx', () => {
  it('reads an authored px length and ignores non-length values', () => {
    const el = document.createElement('div');
    el.style.width = '112px';
    el.style.maxWidth = '90%';
    expect(authoredWidthPx(el, 'width')).toBe(112);
    expect(authoredWidthPx(el, 'maxWidth')).toBeNull();
    expect(authoredWidthPx(el, 'minWidth')).toBeNull();
    expect(authoredWidthPx(el, 'flexBasis')).toBeNull();
  });
});

describe('scaleCard width scaling', () => {
  // Fixed boxes are what clipped at fontScale > 1: the w-28 header gutter cut
  // role labels ("BASH" → "BASI") and the w-10 line badge squeezed the meta.
  function build() {
    const root = document.createElement('div');
    root.style.width = '100%';
    const gutter = document.createElement('span');
    gutter.style.width = '112px';
    gutter.style.flexShrink = '0';
    const fluid = document.createElement('div');
    fluid.style.width = '600px';   // stands in for a resolved auto width
    fluid.style.flexShrink = '1';
    const bounded = document.createElement('div');
    bounded.style.minWidth = '40px';
    bounded.style.maxWidth = '320px';
    bounded.style.flexBasis = '80px';
    root.append(gutter, fluid, bounded);
    return { root, gutter, fluid, bounded };
  }

  it('scales authored widths on fixed boxes', () => {
    const { root, gutter } = build();
    scaleCard(root, 1.35);
    expect(gutter.style.width).toBe(`${112 * 1.35}px`);
  });

  it('scales min-width, max-width and flex-basis', () => {
    const { root, bounded } = build();
    scaleCard(root, 2);
    expect(bounded.style.minWidth).toBe('80px');
    expect(bounded.style.maxWidth).toBe('640px');
    expect(bounded.style.flexBasis).toBe('160px');
  });

  it('never freezes a shrinkable box or the clone root at a scaled width', () => {
    const { root, fluid } = build();
    scaleCard(root, 1.35);
    expect(fluid.style.width).toBe('600px');
    expect(root.style.width).toBe('100%');
  });

  it('is a no-op at factor 1', () => {
    const { root, gutter, bounded } = build();
    scaleCard(root, 1);
    expect(gutter.style.width).toBe('112px');
    expect(bounded.style.maxWidth).toBe('320px');
  });
});

// Read the PDF bytes back as a Latin-1 string so string indices == byte
// offsets (needed to verify the xref table).
async function pdfText(blob: Blob): Promise<string> {
  const bytes = await blobToBytes(blob);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

describe('imageToPdf', () => {
  it('produces an application/pdf blob framed by %PDF and %%EOF', async () => {
    const blob = await imageToPdf(fakeRgb, 800, 600);
    expect(blob.type).toBe('application/pdf');
    const text = await pdfText(blob);
    expect(text.startsWith('%PDF-1.3')).toBe(true);
    expect(text.endsWith('%%EOF')).toBe(true);
  });

  it('embeds the raster LOSSLESSLY — never a JPEG, whose ringing shows on type', async () => {
    const text = await pdfText(await imageToPdf(fakeRgb, 4, 2));
    expect(text).not.toContain('DCTDecode');
    expect(text).toContain('/ColorSpace /DeviceRGB');
    expect(text).toContain('/BitsPerComponent 8');
    // Where CompressionStream exists the stream is deflated; where it does not
    // the raw RGB is written with no filter at all. Both are lossless.
    expect(/\/Filter \/FlateDecode|\/BitsPerComponent 8 \/Length/.test(text)).toBe(true);
  });

  it('keeps the pixel dimensions on the IMAGE while the PAGE carries points', async () => {
    // 975 x 1300 px of paper-column capture → a 234pt (3.25 in) wide page.
    const text = await pdfText(await imageToPdf(fakeRgb, 975, 1300, 234));
    expect(text).toContain('/Width 975 /Height 1300');
    expect(text).toContain('/MediaBox [0 0 234 312]');
  });

  it('defaults to 1pt per pixel when no nominal width is given (screen style)', async () => {
    const text = await pdfText(await imageToPdf(fakeRgb, 800, 600));
    expect(text).toContain('/MediaBox [0 0 800 600]');
  });

  it('writes an xref whose offsets land exactly on each object', async () => {
    const text = await pdfText(await imageToPdf(fakeRgb, 320, 240));
    const m = text.match(/startxref\n(\d+)\n%%EOF$/);
    expect(m).not.toBeNull();
    const xrefStart = Number(m![1]);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe('xref');
    // Lines after "xref" and "0 6": one free entry, then objects 1..5.
    const entries = text.slice(xrefStart).split('\n').slice(2, 8);
    for (let i = 1; i <= 5; i++) {
      const offset = Number(entries[i].slice(0, 10));
      const marker = `${i} 0 obj`;
      expect(text.slice(offset, offset + marker.length)).toBe(marker);
    }
  });
});

// ---------------------------------------------------------------------------
// PDF page geometry — the whole point of the paper style's PDF: the figure is
// placed in LaTeX at 1:1, so the PAGE must already be the physical size.
// ---------------------------------------------------------------------------

describe('pdf page geometry', () => {
  it('maps the paper presets to their exact nominal point widths', () => {
    // 3.25 in x 72 = 234pt; 6.75 in x 72 = 486pt.
    expect(PAPER_WIDTH_PT.col).toBe(234);
    expect(PAPER_WIDTH_PT.full).toBe(486);
    expect(capturePageWidthPt('paper', 'col')).toBe(234);
    expect(capturePageWidthPt('paper', 'full')).toBe(486);
    // A foreign width id still lands on the paper default rather than NaN.
    expect(capturePageWidthPt('paper', 'slide')).toBe(234);
  });

  it('gives the screen style no nominal size — a screenshot has no inches', () => {
    expect(capturePageWidthPt('screen', 'paper1')).toBeUndefined();
    expect(capturePageWidthPt('screen', 'col')).toBeUndefined();
  });

  it('scales the page height from the pixel aspect ratio', () => {
    // The 600 DPI raster of a column figure is 1950 px wide (975 x 2).
    expect(pdfPageSizePt(1950, 2600, 234)).toEqual({ widthPt: 234, heightPt: 312 });
    expect(pdfPageSizePt(2025, 1000, 486)).toEqual({ widthPt: 486, heightPt: 240 });
    // No nominal width → pixels become points, the pre-existing behavior.
    expect(pdfPageSizePt(800, 600)).toEqual({ widthPt: 800, heightPt: 600 });
  });

  it('reports the final PHYSICAL size in inches, supersampling cancelled out', () => {
    // The question a figure raises before it is placed is "does it fit the
    // page?" — which the pixel count cannot answer at an unstated DPI.
    const col = capturePhysicalSizeIn('paper', 'col', 1950, 785)!;
    expect(col.widthIn).toBeCloseTo(3.25, 6);
    expect(col.heightIn).toBeCloseTo(1.308, 3);
    // Same figure, same inches, whatever the rasterizer's scale factor was.
    const supersampled = capturePhysicalSizeIn('paper', 'col', 3900, 1570)!;
    expect(supersampled).toEqual(col);
    expect(capturePhysicalSizeIn('paper', 'full', 4050, 4050)?.widthIn).toBeCloseTo(6.75, 6);
    // A screenshot has no physical size, and neither has an unloaded image.
    expect(capturePhysicalSizeIn('screen', 'paper1', 1200, 800)).toBeNull();
    expect(capturePhysicalSizeIn('paper', 'col', 0, 0)).toBeNull();
  });
});

describe('capture-settings persistence', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to paper1 / md when nothing is stored', () => {
    expect(loadCaptureWidth()).toBe('paper1');
    expect(loadCaptureFontSize()).toBe('md');
  });

  it('round-trips the width preset through localStorage', () => {
    saveCaptureWidth('slide');
    expect(loadCaptureWidth()).toBe('slide');
  });

  it('round-trips the font-size preset through localStorage', () => {
    saveCaptureFontSize('xl');
    expect(loadCaptureFontSize()).toBe('xl');
  });

  it('falls back to the default when the stored value is unknown', () => {
    localStorage.setItem('rollout_viz_capture_width', 'bogus');
    localStorage.setItem('rollout_viz_capture_font', 'huge');
    expect(loadCaptureWidth()).toBe('paper1');
    expect(loadCaptureFontSize()).toBe('md');
  });

  it('defaults the figure style to screen with nothing stored', () => {
    expect(loadCaptureStyle()).toBe('screen');
    expect(loadCapturePaperWidth()).toBe('col');
  });

  it('round-trips the figure style and the paper width', () => {
    saveCaptureStyle('paper');
    saveCapturePaperWidth('full');
    expect(localStorage.getItem('rollout_viz_capture_style')).toBe('paper');
    expect(loadCaptureStyle()).toBe('paper');
    expect(loadCapturePaperWidth()).toBe('full');

    saveCaptureStyle('screen');
    expect(loadCaptureStyle()).toBe('screen');
  });

  it('falls back to screen / col for unknown stored style values', () => {
    localStorage.setItem('rollout_viz_capture_style', 'latex');
    localStorage.setItem('rollout_viz_capture_paper_width', 'slide');
    expect(loadCaptureStyle()).toBe('screen');
    expect(loadCapturePaperWidth()).toBe('col');
  });

  it('keeps the screen and paper width keys apart, so a round trip restores both', () => {
    saveCaptureWidth('slide');
    saveCapturePaperWidth('full');
    expect(loadCaptureWidth()).toBe('slide');
    expect(loadCapturePaperWidth()).toBe('full');
    expect(localStorage.getItem('rollout_viz_capture_width')).toBe('slide');
  });
});

// ---------------------------------------------------------------------------
// Snapshot-time wiring the figure depends on: the embedded fonts and the one
// number the paper rule weights are derived from.
// ---------------------------------------------------------------------------

describe('capture snapshot wiring', () => {
  beforeEach(() => {
    shot.calls.length = 0;
    _resetCaptureFontCache();
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }) as unknown as Response,
    ));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCaptureFontCache();
  });

  function card(): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = '<div class="message-assistant">hi</div>';
    document.body.appendChild(el);
    return el;
  }

  it('hands the rasterizer inlined @font-face CSS — in BOTH styles', async () => {
    await captureCardToPng(card(), { exportWidth: 'col', imageTheme: 'light', captureStyle: 'paper' });
    await captureCardToPng(card(), { exportWidth: 'paper1', imageTheme: 'light' });

    for (const call of shot.calls) {
      expect(call.fontCss).toContain('data:font/woff2;base64,');
      expect(call.fontCss).toContain("font-family:'Inter'");
      expect(call.fontCss).toContain("font-family:'IBM Plex Mono'");
    }
  });

  it('stamps --paper-scale from PAPER_FONT_SCALE so the rule weights follow the type', async () => {
    await captureCardToPng(card(), { exportWidth: 'col', imageTheme: 'light', captureStyle: 'paper' });
    expect(shot.calls[0].paperScale).toBe(String(PAPER_FONT_SCALE));
  });

  it('never stamps --paper-scale on a screen capture', async () => {
    await captureCardToPng(card(), { exportWidth: 'paper1', imageTheme: 'light' });
    expect(shot.calls[0].paperScale).toBe('');
  });

  it('still captures when the font files are unreachable (graceful fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const blob = await captureCardToPng(card(), { exportWidth: 'paper1', imageTheme: 'light' });
    expect(blob).toBeInstanceOf(Blob);
    expect(shot.calls[0].fontCss).toBeUndefined();
  });
});
