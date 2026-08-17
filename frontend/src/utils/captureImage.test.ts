import {
  CAPTURE_ICON_PATHS,
  CAPTURE_PAGE_BG,
  authoredWidthPx,
  imageToPdf,
  loadCaptureWidth,
  saveCaptureWidth,
  loadCaptureFontSize,
  saveCaptureFontSize,
  scaleCard,
} from './captureImage';
import { blobToBytes } from './pngMetadata';

// imageToPdf treats the image payload as opaque bytes, so a stub is fine.
const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);

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
    const blob = imageToPdf(fakeJpeg, 800, 600);
    expect(blob.type).toBe('application/pdf');
    const text = await pdfText(blob);
    expect(text.startsWith('%PDF-1.3')).toBe(true);
    expect(text.endsWith('%%EOF')).toBe(true);
  });

  it('embeds the JPEG via DCTDecode and sizes the page to the image', async () => {
    const text = await pdfText(imageToPdf(fakeJpeg, 800, 600));
    expect(text).toContain('/MediaBox [0 0 800 600]');
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain(`/Length ${fakeJpeg.length}`);
  });

  it('writes an xref whose offsets land exactly on each object', async () => {
    const text = await pdfText(imageToPdf(fakeJpeg, 320, 240));
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
});
