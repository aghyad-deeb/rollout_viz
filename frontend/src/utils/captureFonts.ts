// Font embedding for image capture.
//
// modern-screenshot rasterizes by serializing the cloned DOM into an SVG
// <foreignObject> and drawing that into a canvas. Inside that SVG the page's
// stylesheets are gone: unless the @font-face rules travel WITH the snapshot,
// every glyph falls back to the rasterizer's default face. That is exactly
// what happened while the fonts were served from the Google CDN — a
// cross-origin woff2 cannot be read back and inlined, so every export (screen
// style included) rendered in DejaVu instead of Inter / IBM Plex Mono.
//
// The fix has two halves: the faces are now SELF-HOSTED under public/fonts
// (see index.html + public/fonts/fonts.css), and this module fetches those
// same-origin files once, base64s them, and builds an @font-face CSS string
// that `captureCardToPng` hands to domToBlob's `font.cssText` option.
//
// Everything here is best-effort: a missing / unfetchable font file drops that
// face from the embed rather than failing the capture. With none of them
// available the capture proceeds exactly as before (fallback rendering).

/** One self-hosted face: family + weight + the same-origin woff2 that carries it. */
export interface CaptureFontFace {
  family: string;
  /** `font-weight` descriptor — a range ("400 700") for the variable face. */
  weight: string;
  /** Same-origin URL of the woff2 file. */
  url: string;
  /** The Google Fonts subset range, so the browser still picks the right file. */
  unicodeRange: string;
}

const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, ' +
  'U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, ' +
  'U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, ' +
  'U+2C60-2C7F, U+A720-A7FF';

/**
 * The faces embedded into every capture. Mirrors public/fonts/fonts.css — the
 * two files must stay in sync (that CSS is what the live page loads; this list
 * is what the exported image carries).
 */
export const CAPTURE_FONT_FACES: readonly CaptureFontFace[] = [
  { family: 'Inter', weight: '400 700', url: '/fonts/inter-latin.woff2', unicodeRange: LATIN },
  { family: 'Inter', weight: '400 700', url: '/fonts/inter-latin-ext.woff2', unicodeRange: LATIN_EXT },
  { family: 'IBM Plex Mono', weight: '400', url: '/fonts/plexmono-400-latin.woff2', unicodeRange: LATIN },
  { family: 'IBM Plex Mono', weight: '400', url: '/fonts/plexmono-400-latin-ext.woff2', unicodeRange: LATIN_EXT },
  { family: 'IBM Plex Mono', weight: '500', url: '/fonts/plexmono-500-latin.woff2', unicodeRange: LATIN },
  { family: 'IBM Plex Mono', weight: '500', url: '/fonts/plexmono-500-latin-ext.woff2', unicodeRange: LATIN_EXT },
  { family: 'IBM Plex Mono', weight: '600', url: '/fonts/plexmono-600-latin.woff2', unicodeRange: LATIN },
  { family: 'IBM Plex Mono', weight: '600', url: '/fonts/plexmono-600-latin-ext.woff2', unicodeRange: LATIN_EXT },
];

/** base64 of an ArrayBuffer, chunked so a ~85KB face can't blow the arg limit. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** One `@font-face` rule with the woff2 inlined as a data: URL. */
export function fontFaceRule(face: CaptureFontFace, base64: string): string {
  return (
    `@font-face{font-family:'${face.family}';font-style:normal;` +
    `font-weight:${face.weight};font-display:block;` +
    `src:url(data:font/woff2;base64,${base64}) format('woff2');` +
    `unicode-range:${face.unicodeRange};}`
  );
}

/**
 * Fetch every face and build the embed CSS. Faces that fail to load are simply
 * omitted (the capture still runs, that family just falls back).
 *
 * Exported for tests; production callers use the cached `getCaptureFontCss`.
 */
export async function buildCaptureFontCss(
  faces: readonly CaptureFontFace[] = CAPTURE_FONT_FACES,
): Promise<string> {
  const rules = await Promise.all(
    faces.map(async (face) => {
      try {
        const res = await fetch(face.url);
        if (!res.ok) return '';
        return fontFaceRule(face, toBase64(await res.arrayBuffer()));
      } catch {
        return '';
      }
    }),
  );
  return rules.filter(Boolean).join('\n');
}

// One fetch+encode per page load: ~200KB of woff2 turned into ~270KB of
// base64 is far too much to redo on every preview re-render (the live preview
// re-captures on a 380ms debounce).
let cached: Promise<string> | null = null;

/**
 * The embed CSS, built once and reused. Never rejects — '' means "no embed".
 *
 * Only a NON-EMPTY result is kept. An empty string means every face failed to
 * fetch, which is a TRANSIENT condition (the dev server not up yet, a dropped
 * connection, an offline blip during the first capture of the session) — and
 * latching it would silently condemn every later export in that tab to the
 * rasterizer's fallback face with no way back short of a reload. Dropping the
 * cache on empty costs one retry per failed capture and self-heals.
 */
export function getCaptureFontCss(): Promise<string> {
  if (!cached) {
    const pending = buildCaptureFontCss()
      .catch(() => '')
      .then((css) => {
        // Only unlatch if we are still the cached attempt (a reset + a newer
        // build may have replaced us while this one was in flight).
        if (!css && cached === pending) cached = null;
        return css;
      });
    cached = pending;
  }
  return cached;
}

/** Test hook: drop the cached embed so the next call refetches. */
export function _resetCaptureFontCache(): void {
  cached = null;
}
