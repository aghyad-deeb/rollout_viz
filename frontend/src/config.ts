const FALLBACK_PUBLIC_BASE_URL = 'https://rollout-viz.com';

export function getPublicBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return FALLBACK_PUBLIC_BASE_URL;
}

export function buildPublicUrl(params: URLSearchParams): string {
  return `${getPublicBaseUrl()}/?${params.toString()}`;
}

const ALLOWED_ROLLOUT_PARAMS = new Set([
  'file',
  'rollout',
  'step',
  'index',
  'message',
  'highlight',
  'share',
]);

export function safeSameOriginRolloutUrl(rawUrl: string): string | null {
  try {
    const base = getPublicBaseUrl();
    const url = new URL(rawUrl, base);
    if (url.origin !== base) return null;
    if (url.pathname !== '/') return null;
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_ROLLOUT_PARAMS.has(key)) return null;
    }
    if (!url.searchParams.has('file') && !url.searchParams.has('share')) return null;
    return url.toString();
  } catch {
    return null;
  }
}
