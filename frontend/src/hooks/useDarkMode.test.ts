import { renderHook, act } from '@testing-library/react';
import { useDarkMode } from './useDarkMode';

describe('useDarkMode', () => {
  it('initializes from localStorage when stored', () => {
    localStorage.setItem('rollout-visualizer-dark-mode', 'true');
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.isDarkMode).toBe(true);
  });

  it('initializes from system preference when no localStorage', () => {
    // matchMedia mock returns false by default (from setup.ts)
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.isDarkMode).toBe(false);
  });

  it('toggleDarkMode flips the value', () => {
    const { result } = renderHook(() => useDarkMode());
    const initial = result.current.isDarkMode;
    act(() => {
      result.current.toggleDarkMode();
    });
    expect(result.current.isDarkMode).toBe(!initial);
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.setIsDarkMode(true);
    });
    expect(localStorage.getItem('rollout-visualizer-dark-mode')).toBe('true');
  });

  it('adds dark class when enabled', () => {
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.setIsDarkMode(true);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class when disabled', () => {
    document.documentElement.classList.add('dark');
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.setIsDarkMode(false);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
