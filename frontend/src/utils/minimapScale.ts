import type { Message } from '../types';
import { buildSearchCorpus } from './parseContent';

// ---------------------------------------------------------------------------
// Conversation-minimap block sizing
// ---------------------------------------------------------------------------
// The minimap gives each message a block whose height is *log-scaled* to its
// text length: a 10,000-character tool dump reads as clearly bigger than a
// one-line user turn, but not 500x bigger — the rail has to fit the whole
// conversation. Every block is clamped to a minimum so short messages stay
// clickable, and the heights are normalized to exactly fill the rail so the
// viewport indicator can map scroll position onto it.

/** Minimum rendered height of one minimap block, px. Keeps one-word messages clickable. */
export const MINIMAP_MIN_BLOCK_PX = 7;

/**
 * Log-scale weight of a message with `charCount` characters of text.
 * The +32 floor keeps empty/near-empty messages at a small positive weight
 * instead of -Infinity, and flattens the curve at the very low end.
 */
export function minimapWeight(charCount: number): number {
  return Math.log2(Math.max(0, charCount) + 32);
}

/**
 * The character count the minimap sizes a message by — the same searchable
 * corpus the in-chat search sees (reasoning + visible content + structured
 * tool calls), so block size tracks what the user would actually scroll past.
 */
export function minimapCharCount(message: Message): number {
  return buildSearchCorpus(message).length;
}

/**
 * Distribute `availablePx` of rail height across messages.
 *
 * - Heights are proportional to `minimapWeight(charCount)` (log scale).
 * - Every block gets at least `minPx` (redistributing the remainder among the
 *   unclamped blocks), unless even the minimums don't fit — then every block
 *   gets an equal share of what's there.
 * - The returned heights sum to `availablePx` (when it's positive).
 */
export function computeMinimapHeights(
  charCounts: number[],
  availablePx: number,
  minPx: number = MINIMAP_MIN_BLOCK_PX,
): number[] {
  const n = charCounts.length;
  if (n === 0) return [];
  if (availablePx <= 0) return charCounts.map(() => 0);
  // Not enough room for the minimums: equal shares, nothing else to honor.
  if (minPx * n >= availablePx) return charCounts.map(() => availablePx / n);

  const weights = charCounts.map(minimapWeight);
  const heights = new Array<number>(n).fill(0);
  const clamped = new Array<boolean>(n).fill(false);
  let remainingPx = availablePx;
  let remainingWeight = weights.reduce((a, b) => a + b, 0);

  // Iteratively clamp blocks that would fall below the minimum and
  // redistribute the freed budget among the rest. Terminates: each pass
  // either clamps at least one more block or stops.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (clamped[i]) continue;
      const share = remainingWeight > 0
        ? (weights[i] / remainingWeight) * remainingPx
        : remainingPx / (n - clamped.filter(Boolean).length);
      if (share < minPx) {
        clamped[i] = true;
        heights[i] = minPx;
        remainingPx -= minPx;
        remainingWeight -= weights[i];
        changed = true;
      }
    }
  }
  const freeCount = clamped.filter((c) => !c).length;
  for (let i = 0; i < n; i++) {
    if (!clamped[i]) {
      heights[i] = remainingWeight > 0
        ? (weights[i] / remainingWeight) * remainingPx
        : remainingPx / freeCount;
    }
  }
  return heights;
}
