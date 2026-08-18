import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  CAPTURE_FONT_FACES,
  buildCaptureFontCss,
  fontFaceRule,
  getCaptureFontCss,
  _resetCaptureFontCache,
} from './captureFonts';

// A stand-in woff2 payload; the builder treats the bytes as opaque.
const FAKE_WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);

function mockFetchOk() {
  return vi.fn(async () =>
    ({ ok: true, arrayBuffer: async () => FAKE_WOFF2.buffer.slice(0) }) as unknown as Response,
  );
}

describe('captureFonts', () => {
  beforeEach(() => {
    _resetCaptureFontCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCaptureFontCache();
  });

  it('declares both transcript families, self-hosted (same-origin) so they CAN be inlined', () => {
    const families = new Set(CAPTURE_FONT_FACES.map((f) => f.family));
    expect(families).toEqual(new Set(['Inter', 'IBM Plex Mono']));
    // A cross-origin URL here is the bug this whole module exists to fix.
    for (const face of CAPTURE_FONT_FACES) {
      expect(face.url.startsWith('/fonts/')).toBe(true);
      expect(face.url.endsWith('.woff2')).toBe(true);
    }
    // The mono weights the transcript actually uses (400 body, 600 labels).
    const plexWeights = CAPTURE_FONT_FACES.filter((f) => f.family === 'IBM Plex Mono').map((f) => f.weight);
    expect(new Set(plexWeights)).toEqual(new Set(['400', '500', '600']));
    // Inter is the variable face covering 400–700 (incl. the 450 task body).
    expect(CAPTURE_FONT_FACES.find((f) => f.family === 'Inter')?.weight).toBe('400 700');
  });

  it('emits an @font-face whose src is a base64 data: URL, not a network URL', () => {
    const rule = fontFaceRule(CAPTURE_FONT_FACES[0], 'QUJD');
    expect(rule).toContain("font-family:'Inter'");
    expect(rule).toContain('src:url(data:font/woff2;base64,QUJD) format(\'woff2\')');
    expect(rule).not.toContain('http');
    // `block`, not `swap`: a swap inside the snapshot can rasterize mid-swap.
    expect(rule).toContain('font-display:block');
    expect(rule).toContain('unicode-range:');
  });

  it('builds one embedded face per file, covering both families', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    const css = await buildCaptureFontCss();

    expect(fetchMock).toHaveBeenCalledTimes(CAPTURE_FONT_FACES.length);
    expect(css.match(/@font-face/g)).toHaveLength(CAPTURE_FONT_FACES.length);
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).toContain("font-family:'Inter'");
    expect(css).toContain("font-family:'IBM Plex Mono'");
    expect(css).not.toContain('fonts.gstatic.com');
  });

  it('drops a face that fails to load instead of failing the capture', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false } as unknown as Response;
      if (call === 2) throw new Error('offline');
      return { ok: true, arrayBuffer: async () => FAKE_WOFF2.buffer.slice(0) } as unknown as Response;
    }));

    const css = await buildCaptureFontCss();
    expect(css.match(/@font-face/g)).toHaveLength(CAPTURE_FONT_FACES.length - 2);
  });

  it('returns "" (no embed) rather than rejecting when every face is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(getCaptureFontCss()).resolves.toBe('');
  });

  it('does NOT latch a failed build — the next capture retries and self-heals', async () => {
    // An empty result means every face failed, which is transient (dev server
    // still starting, a dropped connection). Caching it condemned every later
    // export in the tab to the fallback face until a full page reload.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(getCaptureFontCss()).resolves.toBe('');

    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);
    const recovered = await getCaptureFontCss();

    expect(recovered.match(/@font-face/g)).toHaveLength(CAPTURE_FONT_FACES.length);
    expect(fetchMock).toHaveBeenCalledTimes(CAPTURE_FONT_FACES.length);
    // …and the recovered (non-empty) result IS latched from then on.
    const again = await getCaptureFontCss();
    expect(again).toBe(recovered);
    expect(fetchMock).toHaveBeenCalledTimes(CAPTURE_FONT_FACES.length);
  });

  it('fetches once per page load — the live preview re-captures on a debounce', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    const first = await getCaptureFontCss();
    const second = await getCaptureFontCss();

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(CAPTURE_FONT_FACES.length);
  });
});
