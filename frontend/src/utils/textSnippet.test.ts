import { describe, it, expect } from 'vitest';
import { extractHighlightAnchor } from './textSnippet';

describe('extractHighlightAnchor', () => {
  // Outer whitespace
  it('trims leading and trailing whitespace from short input', () => {
    expect(extractHighlightAnchor('   hello world   ')).toBe('hello world');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(extractHighlightAnchor('   \n\t  ')).toBe('');
    expect(extractHighlightAnchor('')).toBe('');
  });

  // Line breaks
  it('cuts at first newline', () => {
    expect(extractHighlightAnchor('first line\nsecond line')).toBe('first line');
  });

  it('cuts at \\r\\n', () => {
    expect(extractHighlightAnchor('first\r\nsecond')).toBe('first');
  });

  it('cuts at Unicode LINE SEPARATOR (U+2028)', () => {
    // Construct U+2028 at runtime so the test source stays pure ASCII.
    const sep = String.fromCharCode(0x2028);
    expect(extractHighlightAnchor(`alpha${sep}beta`)).toBe('alpha');
  });

  it('cuts at the first newline, ignoring sentence terminators after it', () => {
    expect(extractHighlightAnchor('alpha beta\nthe quick brown fox.')).toBe('alpha beta');
  });

  // Sentence terminators
  it('cuts at first period followed by space', () => {
    expect(extractHighlightAnchor('First sentence. Second sentence.'))
      .toBe('First sentence.');
  });

  it('cuts at first ? or !', () => {
    expect(extractHighlightAnchor('Why? Because reasons.')).toBe('Why?');
    expect(extractHighlightAnchor('Wow! Cool stuff.')).toBe('Wow!');
  });

  it('does NOT cut on decimals (1.5)', () => {
    expect(extractHighlightAnchor('The value is 1.5 in this case.'))
      .toBe('The value is 1.5 in this case.');
  });

  it('does NOT cut on version numbers (v1.2.3)', () => {
    expect(extractHighlightAnchor('Use v1.2.3 for compatibility.'))
      .toBe('Use v1.2.3 for compatibility.');
  });

  it('does NOT cut on domain names (example.com)', () => {
    expect(extractHighlightAnchor('Visit example.com today.'))
      .toBe('Visit example.com today.');
  });

  it('newline outranks later sentence end', () => {
    expect(extractHighlightAnchor('First line\nSecond line is here.'))
      .toBe('First line');
  });

  // Hard char cap
  it('caps at maxChars when there is no newline or sentence end', () => {
    const long = 'word '.repeat(60);
    const result = extractHighlightAnchor(long, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(long.startsWith(result)).toBe(true);
  });

  it('rolls back to last word boundary when cap is mid-word', () => {
    const text = 'short word extraordinary';
    const result = extractHighlightAnchor(text, 15);
    expect(result).toBe('short word');
  });

  it('does not roll back so far that less than half the cap remains', () => {
    const text = 'verylongword more text here';
    const result = extractHighlightAnchor(text, 20);
    expect(result.length).toBeGreaterThan(10);
  });

  // Combinations / earliest-wins
  it('uses the earliest of newline, sentence end, and cap', () => {
    expect(extractHighlightAnchor('hi a.\nlong tail of more text', 100))
      .toBe('hi a.');
  });

  it('returns the full input when no cutoff applies and within cap', () => {
    expect(extractHighlightAnchor('short text no period'))
      .toBe('short text no period');
  });

  // Real-world-ish
  it('extracts first sentence from a multi-paragraph quote', () => {
    const quote = [
      'The model showed clear signs of reward hacking.',
      'It modified the test fixture so the evaluator script would pass.',
      'This is misaligned behavior.',
    ].join('\n');
    expect(extractHighlightAnchor(quote))
      .toBe('The model showed clear signs of reward hacking.');
  });

  it('handles a one-liner with no terminator and reasonable length', () => {
    expect(extractHighlightAnchor('Just a short label'))
      .toBe('Just a short label');
  });
});
