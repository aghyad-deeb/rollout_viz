// Extract a short "anchor" from a longer selection — used as the
// `highlight=` URL parameter on hyperlinks created by Cmd+C inside the
// chat view. The full selection still lands on the clipboard as
// `text/html` and `text/plain`; this snippet is only what the recipient's
// browser will mark when they click through.
//
// Two reasons not to use the full selection as the highlight target:
//
//   1. Robustness. The receiver matches `highlight` against message
//      content with `text.indexOf` (whitespace-normalised). The longer
//      the search string, the higher the chance one byte of difference
//      between source and rendered content silently breaks the match.
//      A first-sentence anchor is short enough to almost always match.
//
//   2. URL hygiene. `highlight=` is percent-encoded into the query
//      string, so a 600-character paragraph balloons into a 1.5 KB URL
//      that some chat clients refuse to paste cleanly.
//
// Cutoff is the *earliest* of:
//   • first line break (line break = logical block boundary; a highlight
//     that spans paragraphs almost always loses to whitespace drift)
//   • first sentence terminator — `.`, `!`, or `?` followed by whitespace
//     or end of string
//   • a hard character cap (default 120), rolled back to the last word
//     boundary if the cap lands mid-word

const DEFAULT_MAX_CHARS = 120;

// Line-break-class characters: ASCII LF/CR plus Unicode LINE SEPARATOR
// (U+2028) and PARAGRAPH SEPARATOR (U+2029). Same set the spec calls
// out as line terminators for JS source — close enough to "the user
// likely sees a visual break here" for our purposes.
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;

// `.` `!` `?` followed by whitespace or end of string. The lookahead
// keeps the punctuation in the match (so we slice up to and including
// the period) while requiring it to be followed by a real boundary —
// this avoids splitting on decimals (`1.5`), version numbers (`v1.2.3`),
// or domain names (`example.com`). It still splits on abbreviations
// (`Mr. Smith`, `etc. and`); we accept that as a reasonable tradeoff for
// a regex that's understandable in one line.
const SENTENCE_END_RE = /[.!?](?=\s|$)/;

export function extractHighlightAnchor(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  let cutoff = Math.min(trimmed.length, maxChars);

  // First line break.
  const newlineIdx = trimmed.search(LINE_BREAK_RE);
  if (newlineIdx !== -1 && newlineIdx < cutoff) {
    cutoff = newlineIdx;
  }

  // First sentence end (only if it falls before the current cutoff).
  const sentenceMatch = trimmed.match(SENTENCE_END_RE);
  if (sentenceMatch && sentenceMatch.index !== undefined) {
    const sentenceEnd = sentenceMatch.index + 1; // include the punctuation
    if (sentenceEnd < cutoff) cutoff = sentenceEnd;
  }

  // If we hit the hard cap mid-word, back up to the previous word
  // boundary — but only if doing so still leaves at least half the
  // budget. Preserves at least *some* content for pathological inputs
  // like one-giant-word-no-spaces.
  if (cutoff === maxChars && cutoff < trimmed.length) {
    const lastSpace = trimmed.slice(0, cutoff).lastIndexOf(' ');
    if (lastSpace > maxChars * 0.5) {
      cutoff = lastSpace;
    }
  }

  return trimmed.slice(0, cutoff).trim();
}
