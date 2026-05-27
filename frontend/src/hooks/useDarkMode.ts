import { useState, useEffect } from 'react';

const STORAGE_KEY = 'rollout-visualizer-dark-mode';

export function useDarkMode() {
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    // Check localStorage first
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        return JSON.parse(stored);
      }
    } catch {
      // Ignore localStorage errors
    }
    // Fall back to system preference
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

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
    
    // Persist to localStorage
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(isDarkMode));
    } catch {
      // Ignore localStorage errors
    }
  }, [isDarkMode]);

  const toggleDarkMode = () => setIsDarkMode(prev => !prev);

  return { isDarkMode, setIsDarkMode, toggleDarkMode };
}
