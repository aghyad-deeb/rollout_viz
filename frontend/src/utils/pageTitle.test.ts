import { describe, it, expect } from 'vitest';
import { buildPageTitle } from './pageTitle';

describe('buildPageTitle', () => {
  it('uses experimentName as the base when present', () => {
    expect(buildPageTitle({ experimentName: 'my-exp' })).toBe(
      'my-exp — Rollout Visualizer'
    );
  });

  it('appends the rollout number when rolloutN is defined', () => {
    expect(buildPageTitle({ experimentName: 'my-exp', rolloutN: 7 })).toBe(
      'my-exp · rollout 7 — Rollout Visualizer'
    );
  });

  it('includes rollout 0 (rolloutN of zero is still defined)', () => {
    expect(buildPageTitle({ experimentName: 'my-exp', rolloutN: 0 })).toBe(
      'my-exp · rollout 0 — Rollout Visualizer'
    );
  });

  it('falls back to the sourceFile basename, stripping directories and .jsonl', () => {
    expect(buildPageTitle({ sourceFile: '/data/logs/run_42.jsonl' })).toBe(
      'run_42 — Rollout Visualizer'
    );
  });

  it('handles S3 paths in sourceFile', () => {
    expect(
      buildPageTitle({ sourceFile: 's3://bucket/prefix/traces.jsonl', rolloutN: 3 })
    ).toBe('traces · rollout 3 — Rollout Visualizer');
  });

  it('only strips a trailing .jsonl extension', () => {
    expect(buildPageTitle({ sourceFile: '/x/my.jsonl.backup' })).toBe(
      'my.jsonl.backup — Rollout Visualizer'
    );
  });

  it('prefers experimentName over sourceFile', () => {
    expect(
      buildPageTitle({ experimentName: 'exp', sourceFile: '/a/b.jsonl' })
    ).toBe('exp — Rollout Visualizer');
  });

  it('treats an empty experimentName as absent and falls back to sourceFile', () => {
    expect(buildPageTitle({ experimentName: '', sourceFile: '/a/b.jsonl' })).toBe(
      'b — Rollout Visualizer'
    );
  });

  it('returns the shared-mode title when there is no base and isSharedMode is true', () => {
    expect(buildPageTitle({ isSharedMode: true })).toBe(
      'Shared rollout — Rollout Visualizer'
    );
  });

  it('ignores rolloutN when there is no base', () => {
    expect(buildPageTitle({ rolloutN: 5, isSharedMode: true })).toBe(
      'Shared rollout — Rollout Visualizer'
    );
  });

  it('returns the plain app title when nothing is provided', () => {
    expect(buildPageTitle({})).toBe('Rollout Visualizer');
  });

  it('returns the plain app title for an empty sourceFile and no shared mode', () => {
    expect(buildPageTitle({ sourceFile: '', isSharedMode: false })).toBe(
      'Rollout Visualizer'
    );
  });

  it('returns the plain app title when the sourceFile basename is empty', () => {
    expect(buildPageTitle({ sourceFile: '/data/logs/' })).toBe(
      'Rollout Visualizer'
    );
  });
});
