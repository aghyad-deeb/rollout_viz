import { useState, useEffect, useCallback, type SetStateAction } from 'react';

const THEME_STORAGE_KEY = 'rollout-visualizer-theme-preference';
const LEGACY_STORAGE_KEY = 'rollout-visualizer-dark-mode';
type ThemePreference = 'system' | 'light' | 'dark';

function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function loadThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Ignore localStorage errors
  }
  return 'system';
}

function resolveDarkMode(preference: ThemePreference, systemPrefersDark: boolean): boolean {
  if (preference === 'system') return systemPrefersDark;
  return preference === 'dark';
}

export function useDarkMode() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(getSystemPrefersDark);
  const isDarkMode = resolveDarkMode(themePreference, systemPrefersDark);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }

    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  useEffect(() => {
    // Update theme class. It lives on #root (not <html>) so off-screen
    // capture containers appended to <body> are outside it — letting a
    // capture render in its own image-theme, independent of the UI theme.
    const themeRoot = document.getElementById('root') ?? document.documentElement;
    if (isDarkMode) {
      themeRoot.classList.add('dark');
    } else {
      themeRoot.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      if (themePreference === 'system') {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        localStorage.setItem(THEME_STORAGE_KEY, themePreference);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [themePreference]);

  const setIsDarkMode = useCallback((next: SetStateAction<boolean>) => {
    const nextValue = typeof next === 'function' ? next(isDarkMode) : next;
    setThemePreference(nextValue ? 'dark' : 'light');
  }, [isDarkMode]);

  const toggleDarkMode = useCallback(() => {
    setIsDarkMode(prev => !prev);
  }, [setIsDarkMode]);

  return { isDarkMode, setIsDarkMode, toggleDarkMode, themePreference };
}
