import { renderHook, act } from '@testing-library/react';
import { useDarkMode } from './useDarkMode';

const THEME_STORAGE_KEY = 'rollout-visualizer-theme-preference';
const LEGACY_STORAGE_KEY = 'rollout-visualizer-dark-mode';

type MatchMediaMock = ReturnType<typeof mockMatchMedia>;

function mockMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const legacyListeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.delete(listener);
    }),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      legacyListeners.add(listener);
    }),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      legacyListeners.delete(listener);
    }),
    dispatchEvent: vi.fn(() => false),
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(() => media as unknown as MediaQueryList);
  return {
    media,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches: nextMatches, media: media.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
      for (const listener of legacyListeners) listener(event);
    },
  };
}

function themeRoot(): HTMLElement {
  let root = document.getElementById('root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  }
  return root;
}

describe('useDarkMode', () => {
  let media: MatchMediaMock;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    media = mockMatchMedia(false);
  });

  it('initializes from an explicit stored dark preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.isDarkMode).toBe(true);
    expect(result.current.themePreference).toBe('dark');
  });

  it('initializes from an explicit stored light preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    media.setMatches(true);
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.isDarkMode).toBe(false);
    expect(result.current.themePreference).toBe('light');
  });

  it('initializes from system preference when no explicit preference is stored', () => {
    media.setMatches(true);
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.isDarkMode).toBe(true);
    expect(result.current.themePreference).toBe('system');
  });

  it('follows system preference changes while in system mode', () => {
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.isDarkMode).toBe(false);

    act(() => {
      media.setMatches(true);
    });
    expect(result.current.isDarkMode).toBe(true);

    act(() => {
      media.setMatches(false);
    });
    expect(result.current.isDarkMode).toBe(false);
  });

  it('toggleDarkMode pins an explicit preference', () => {
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.toggleDarkMode();
    });
    expect(result.current.isDarkMode).toBe(true);
    expect(result.current.themePreference).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('ignores system changes after an explicit toggle', () => {
    media.setMatches(true);
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.toggleDarkMode();
    });
    expect(result.current.isDarkMode).toBe(false);
    expect(result.current.themePreference).toBe('light');

    act(() => {
      media.setMatches(false);
    });
    expect(result.current.isDarkMode).toBe(false);

    act(() => {
      media.setMatches(true);
    });
    expect(result.current.isDarkMode).toBe(false);
  });

  it('setIsDarkMode pins an explicit preference', () => {
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.setIsDarkMode(true);
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('does not persist system mode as an explicit preference', () => {
    renderHook(() => useDarkMode());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('removes the legacy auto-written boolean preference', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, 'false');
    renderHook(() => useDarkMode());
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('adds dark class to the app root when enabled', () => {
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.setIsDarkMode(true);
    });
    expect(themeRoot().classList.contains('dark')).toBe(true);
  });

  it('removes dark class from the app root when disabled', () => {
    themeRoot().classList.add('dark');
    const { result } = renderHook(() => useDarkMode());
    act(() => {
      result.current.setIsDarkMode(false);
    });
    expect(themeRoot().classList.contains('dark')).toBe(false);
  });
});
