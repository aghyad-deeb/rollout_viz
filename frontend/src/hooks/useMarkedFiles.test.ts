import { renderHook, act } from '@testing-library/react';
import { useMarkedFiles } from './useMarkedFiles';

describe('useMarkedFiles', () => {
  it('initializes empty when no localStorage', () => {
    const { result } = renderHook(() => useMarkedFiles());
    expect(result.current.markedFiles.size).toBe(0);
  });

  it('initializes from localStorage', () => {
    localStorage.setItem('rollout-visualizer-marked-files', JSON.stringify(['file1.jsonl', 'file2.jsonl']));
    const { result } = renderHook(() => useMarkedFiles());
    expect(result.current.markedFiles.size).toBe(2);
    expect(result.current.isMarked('file1.jsonl')).toBe(true);
  });

  it('toggleMark adds when not present', () => {
    const { result } = renderHook(() => useMarkedFiles());
    act(() => {
      result.current.toggleMark('test.jsonl');
    });
    expect(result.current.isMarked('test.jsonl')).toBe(true);
  });

  it('toggleMark removes when present', () => {
    const { result } = renderHook(() => useMarkedFiles());
    act(() => {
      result.current.markFile('test.jsonl');
    });
    act(() => {
      result.current.toggleMark('test.jsonl');
    });
    expect(result.current.isMarked('test.jsonl')).toBe(false);
  });

  it('markFile adds file', () => {
    const { result } = renderHook(() => useMarkedFiles());
    act(() => {
      result.current.markFile('a.jsonl');
    });
    expect(result.current.isMarked('a.jsonl')).toBe(true);
  });

  it('unmarkFile removes file', () => {
    const { result } = renderHook(() => useMarkedFiles());
    act(() => {
      result.current.markFile('a.jsonl');
    });
    act(() => {
      result.current.unmarkFile('a.jsonl');
    });
    expect(result.current.isMarked('a.jsonl')).toBe(false);
  });

  it('clearAllMarks empties set', () => {
    const { result } = renderHook(() => useMarkedFiles());
    act(() => {
      result.current.markFile('a.jsonl');
      result.current.markFile('b.jsonl');
    });
    act(() => {
      result.current.clearAllMarks();
    });
    expect(result.current.markedFiles.size).toBe(0);
  });

  it('isMarked returns false for unmarked', () => {
    const { result } = renderHook(() => useMarkedFiles());
    expect(result.current.isMarked('nonexistent.jsonl')).toBe(false);
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useMarkedFiles());
    act(() => {
      result.current.markFile('test.jsonl');
    });
    const stored = JSON.parse(localStorage.getItem('rollout-visualizer-marked-files') || '[]');
    expect(stored).toContain('test.jsonl');
  });
});
