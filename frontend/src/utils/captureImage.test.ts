import {
  imageToPdf,
  loadCaptureWidth,
  saveCaptureWidth,
  loadCaptureFontSize,
  saveCaptureFontSize,
} from './captureImage';
import { blobToBytes } from './pngMetadata';

// imageToPdf treats the image payload as opaque bytes, so a stub is fine.
const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);

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
