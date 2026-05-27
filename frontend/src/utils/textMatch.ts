// Whitespace-tolerant substring matching shared by:
//   • MessageCard's highlight cascade (URL share, ephemeral, grade quote,
//     local Ctrl+F, global filter-bar search) — they all need offsets in
//     the *original* text so rendered marks slice unmodified content.
//   • ChatView's local Ctrl+F counter — it just needs occurrence counts.
//
// Why this exists: LLMs and editors silently swap whitespace codepoints —
// Claude echoes a plain `"7 am"` back with a U+202F narrow space, and
// copy-pasted text often gains U+00A0 spaces. A bare `text.indexOf(quote.text)`
// then misses the match. Every mapping in WHITESPACE_NORMALIZE_RE is one
// codepoint → one codepoint, so character offsets are preserved: we
// search on normalized copies but slice the original.

const WHITESPACE_NORMALIZE_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function normalizeWs(s: string): string {
  return s.replace(WHITESPACE_NORMALIZE_RE, ' ');
}

// Find all occurrences of `needle` inside `haystack`, comparing on
// whitespace-normalized copies but reporting offsets in the original
// string. Returns `[]` for an empty needle (rather than infinite-looping).
export function findAllMatches(
  haystack: string,
  needle: string,
): Array<{ start: number; end: number }> {
  if (!needle) return [];
  const hNorm = normalizeWs(haystack);
  const nNorm = normalizeWs(needle);
  if (!nNorm) return [];
  const results: Array<{ start: number; end: number }> = [];
  let searchIndex = 0;
  let matchIndex = hNorm.indexOf(nNorm, searchIndex);
  while (matchIndex !== -1) {
    // 1:1 codepoint normalization → offsets are identical in both strings.
    results.push({ start: matchIndex, end: matchIndex + nNorm.length });
    searchIndex = matchIndex + nNorm.length;
    matchIndex = hNorm.indexOf(nNorm, searchIndex);
  }
  return results;
}

// Case-insensitive variant. Used by local Ctrl+F search and global
// filter-bar search so "Foo" matches "foo" and vice versa.
export function findAllMatchesCI(
  haystack: string,
  needle: string,
): Array<{ start: number; end: number }> {
  if (!needle) return [];
  const hNorm = normalizeWs(haystack).toLowerCase();
  const nNorm = normalizeWs(needle).toLowerCase();
  if (!nNorm) return [];
  const results: Array<{ start: number; end: number }> = [];
  let searchIndex = 0;
  let matchIndex = hNorm.indexOf(nNorm, searchIndex);
  while (matchIndex !== -1) {
    results.push({ start: matchIndex, end: matchIndex + nNorm.length });
    searchIndex = matchIndex + nNorm.length;
    matchIndex = hNorm.indexOf(nNorm, searchIndex);
  }
  return results;
}
