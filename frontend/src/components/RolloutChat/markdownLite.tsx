import { Fragment } from 'react';
import type { ReactNode } from 'react';

// Minimal, streaming-safe markdown renderer for assistant chat replies.
// Deliberately tiny: fenced ``` code blocks, `inline code`, **bold**, and
// "- " / "N. " list markers. Everything else passes through verbatim — the
// surrounding container uses `whitespace-pre-wrap`, so newlines survive.

// Subtle theme-safe code background — translucent so it works on any card.
const CODE_BG = 'bg-black/5 dark:bg-white/10';

// One combined pass: `inline code` first (backticks win over bold inside
// them), then **bold**. Neither spans a newline.
const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

// A list marker at the start of a line: "- item" or "12. item".
const LIST_LINE_RE = /^(\s*)(- |\d+\. )(.*)$/;
const HAS_LIST_LINE_RE = /^\s*(?:- |\d+\. )/m;

/** Inline formatting for one prose run. Plain runs come back as the string itself. */
function applyInline(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(INLINE_RE);
  if (parts.length === 1) return text; // no markdown — unfragmented passthrough
  return parts.map((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={`${keyPrefix}c${i}`} className={`font-mono text-xs px-1 py-0.5 rounded ${CODE_BG}`}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={`${keyPrefix}b${i}`} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

/** A prose chunk (between fences): list markers per line + inline formatting. */
function renderProse(text: string, keyPrefix: string): ReactNode {
  if (!HAS_LIST_LINE_RE.test(text)) return applyInline(text, keyPrefix);
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push('\n');
    const m = LIST_LINE_RE.exec(line);
    if (!m) {
      out.push(<Fragment key={`${keyPrefix}l${i}`}>{applyInline(line, `${keyPrefix}l${i}`)}</Fragment>);
      return;
    }
    const [, indent, marker, rest] = m;
    out.push(
      <Fragment key={`${keyPrefix}l${i}`}>
        {indent}
        <span className="font-semibold">{marker === '- ' ? '• ' : marker}</span>
        {applyInline(rest, `${keyPrefix}l${i}`)}
      </Fragment>,
    );
  });
  return out;
}

/**
 * Render assistant text with markdown-lite formatting.
 *
 * Splits on ``` fence delimiters — odd segments are code. A trailing segment
 * with no closing ``` is treated as a still-open code block, so a fence that
 * is mid-stream renders as code immediately instead of flickering as prose.
 * Plain text with no markdown at all is returned as the original string.
 */
export function renderMarkdownLite(text: string): ReactNode {
  const segments = text.split('```');
  if (segments.length === 1) return renderProse(text, 'm');
  const out: ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (i % 2 === 0) {
      // Prose between fences — drop the single newline hugging a delimiter so
      // the <pre> block doesn't gain blank lines around it.
      let prose = seg;
      if (i > 0 && prose.startsWith('\n')) prose = prose.slice(1);
      if (i < segments.length - 1 && prose.endsWith('\n')) prose = prose.slice(0, -1);
      if (prose) out.push(<Fragment key={`s${i}`}>{renderProse(prose, `s${i}`)}</Fragment>);
      return;
    }
    // Code fence. The first line is the info string (language tag); an
    // unterminated trailing fence with no newline yet is still streaming its
    // info string, so it renders as an empty block rather than leaking "py".
    const isOpenFence = i === segments.length - 1;
    const nl = seg.indexOf('\n');
    let code = nl === -1 ? (isOpenFence ? '' : seg) : seg.slice(nl + 1);
    if (code.endsWith('\n')) code = code.slice(0, -1);
    out.push(
      <pre
        key={`s${i}`}
        className={`font-mono text-xs px-2 py-1.5 my-1 rounded overflow-x-auto ${CODE_BG}`}
      >
        {code}
      </pre>,
    );
  });
  return out;
}
