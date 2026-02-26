import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('hello', 150));
    expect(result.current).toBe('hello');
  });

  it('updates after delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 150),
      { initialProps: { value: 'a' } }
    );

    expect(result.current).toBe('a');

    // Change value
    rerender({ value: 'b' });
    // Should still be 'a' immediately
    expect(result.current).toBe('a');

    // Advance past delay
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe('b');
  });

  it('resets timer on rapid changes', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 150),
      { initialProps: { value: 'a' } }
    );

    // Rapid changes
    rerender({ value: 'b' });
    act(() => { vi.advanceTimersByTime(50); });
    rerender({ value: 'c' });
    act(() => { vi.advanceTimersByTime(50); });
    rerender({ value: 'd' });

    // Not enough time has passed for any debounce
    expect(result.current).toBe('a');

    // Advance past delay from last change
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Should have the final value, not intermediate ones
    expect(result.current).toBe('d');
  });
});
