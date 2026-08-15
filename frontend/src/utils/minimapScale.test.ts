import { describe, it, expect } from 'vitest';
import {
  computeMinimapHeights,
  minimapWeight,
  minimapCharCount,
  MINIMAP_MIN_BLOCK_PX,
} from './minimapScale';
import { makeMessage } from '../test/fixtures';
import type { Message } from '../types';

describe('minimapWeight', () => {
  it('is monotonically non-decreasing in char count', () => {
    const counts = [0, 1, 10, 100, 1000, 10000, 100000];
    const weights = counts.map(minimapWeight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
    }
  });

  it('is log-scale: 100x the characters is far less than 100x the weight', () => {
    const small = minimapWeight(100);
    const large = minimapWeight(10000);
    expect(large).toBeGreaterThan(small);
    expect(large / small).toBeLessThan(3);
  });

  it('stays finite and positive for zero-length messages', () => {
    expect(minimapWeight(0)).toBeGreaterThan(0);
    expect(Number.isFinite(minimapWeight(0))).toBe(true);
  });
});

describe('minimapCharCount', () => {
  it('counts visible content', () => {
    expect(minimapCharCount(makeMessage('user', 'hello'))).toBeGreaterThanOrEqual(5);
  });

  it('includes reasoning and tool calls, not just content', () => {
    const bare = makeMessage('assistant', 'answer');
    const rich: Message = {
      ...makeMessage('assistant', 'answer'),
      reasoning: 'a long chain of thought '.repeat(20),
      tool_calls: [{ type: 'function', function: { name: 'bash', arguments: { command: 'ls -la /tmp' } } }],
    };
    expect(minimapCharCount(rich)).toBeGreaterThan(minimapCharCount(bare));
  });
});

describe('computeMinimapHeights', () => {
  it('returns an empty array for no messages', () => {
    expect(computeMinimapHeights([], 500)).toEqual([]);
  });

  it('returns zeros when no space is available', () => {
    expect(computeMinimapHeights([10, 20], 0)).toEqual([0, 0]);
  });

  it('gives longer messages taller blocks', () => {
    const heights = computeMinimapHeights([10, 10000, 100], 400);
    expect(heights[1]).toBeGreaterThan(heights[0]);
    expect(heights[1]).toBeGreaterThan(heights[2]);
    expect(heights[2]).toBeGreaterThan(heights[0]);
  });

  it('compresses extremes (log scale): a 1000x longer message is not 1000x taller', () => {
    const heights = computeMinimapHeights([10, 10000], 400);
    expect(heights[1] / heights[0]).toBeLessThan(10);
  });

  it('clamps short messages to the minimum block height', () => {
    const heights = computeMinimapHeights([0, 200000, 200000, 200000], 400);
    expect(heights[0]).toBeGreaterThanOrEqual(MINIMAP_MIN_BLOCK_PX);
  });

  it('sums to the available height', () => {
    const heights = computeMinimapHeights([5, 12000, 340, 0, 999], 512);
    const sum = heights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(512, 6);
  });

  it('falls back to equal shares when even the minimums do not fit', () => {
    const heights = computeMinimapHeights([1, 100000], 8, 7);
    expect(heights[0]).toBeCloseTo(4, 6);
    expect(heights[1]).toBeCloseTo(4, 6);
  });

  it('gives equal-length messages equal heights', () => {
    const heights = computeMinimapHeights([500, 500, 500], 300);
    expect(heights[0]).toBeCloseTo(heights[1], 6);
    expect(heights[1]).toBeCloseTo(heights[2], 6);
  });
});
