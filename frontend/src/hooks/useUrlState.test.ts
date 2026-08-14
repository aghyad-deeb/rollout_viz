import { renderHook, act } from '@testing-library/react';
import { useUrlState } from './useUrlState';

describe('useUrlState', () => {
  beforeEach(() => {
    // Reset URL to clean state
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        search: '',
        pathname: '/',
        origin: 'http://localhost:3000',
        hostname: 'localhost',
      },
    });
  });

  describe('getUrlState', () => {
    it('parses file parameter', () => {
      window.location.search = '?file=test.jsonl';
      const { result } = renderHook(() => useUrlState());
      const state = result.current.getUrlState();
      expect(state.file).toBe('test.jsonl');
    });

    it('parses rollout as integer', () => {
      window.location.search = '?rollout=42';
      const { result } = renderHook(() => useUrlState());
      const state = result.current.getUrlState();
      expect(state.rollout).toBe(42);
    });

    it('parses message as integer', () => {
      window.location.search = '?message=3';
      const { result } = renderHook(() => useUrlState());
      const state = result.current.getUrlState();
      expect(state.message).toBe(3);
    });

    it('parses highlight parameter', () => {
      window.location.search = '?highlight=some%20text';
      const { result } = renderHook(() => useUrlState());
      const state = result.current.getUrlState();
      expect(state.highlight).toBe('some text');
    });

    it('handles missing params', () => {
      window.location.search = '';
      const { result } = renderHook(() => useUrlState());
      const state = result.current.getUrlState();
      expect(state.file).toBeUndefined();
      expect(state.rollout).toBeUndefined();
      expect(state.message).toBeUndefined();
      expect(state.highlight).toBeUndefined();
    });

    it('parses all params together', () => {
      window.location.search = '?file=test.jsonl&rollout=5&message=2&highlight=hello';
      const { result } = renderHook(() => useUrlState());
      const state = result.current.getUrlState();
      expect(state.file).toBe('test.jsonl');
      expect(state.rollout).toBe(5);
      expect(state.message).toBe(2);
      expect(state.highlight).toBe('hello');
    });

    it('parses index as integer — the canonical sample identifier', () => {
      window.location.search = '?file=test.jsonl&index=7';
      const { result } = renderHook(() => useUrlState());
      expect(result.current.getUrlState().index).toBe(7);
    });

    it('parses index=0 (first sample must not be dropped as falsy)', () => {
      window.location.search = '?file=test.jsonl&index=0';
      const { result } = renderHook(() => useUrlState());
      expect(result.current.getUrlState().index).toBe(0);
    });
  });

  describe('setUrlState', () => {
    it('calls replaceState with params', () => {
      const { result } = renderHook(() => useUrlState());
      act(() => {
        result.current.setUrlState({ file: 'test.jsonl', rollout: 5 });
      });
      expect(window.history.replaceState).toHaveBeenCalled();
      const url = (window.history.replaceState as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(url).toContain('file=test.jsonl');
      expect(url).toContain('rollout=5');
    });

    it('omits undefined params', () => {
      const { result } = renderHook(() => useUrlState());
      act(() => {
        result.current.setUrlState({ file: 'test.jsonl' });
      });
      const url = (window.history.replaceState as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(url).toContain('file=test.jsonl');
      expect(url).not.toContain('rollout');
    });

    it('clears URL when empty state', () => {
      const { result } = renderHook(() => useUrlState());
      act(() => {
        result.current.setUrlState({});
      });
      const url = (window.history.replaceState as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(url).toBe('/');
    });
  });

  describe('generateLink', () => {
    it('builds full URL with params', () => {
      const { result } = renderHook(() => useUrlState());
      const link = result.current.generateLink({ file: 'test.jsonl', rollout: 3 });
      expect(link).toContain('http://localhost:3000');
      expect(link).toContain('file=test.jsonl');
      expect(link).toContain('rollout=3');
    });

    it('encodes special characters', () => {
      const { result } = renderHook(() => useUrlState());
      const link = result.current.generateLink({ file: 'path/to/file.jsonl', highlight: 'hello world' });
      expect(link).toContain('file=path');
      expect(link).toContain('highlight=hello');
    });

    it('dual-emits index alongside rollout during the migration window', () => {
      // ?index= is canonical (resolved first by App); ?rollout= stays for
      // legacy readers. Links carry both so either side can resolve them.
      const { result } = renderHook(() => useUrlState());
      const link = result.current.generateLink({ file: 'test.jsonl', rollout: 3, step: 1, index: 12 });
      expect(link).toContain('index=12');
      expect(link).toContain('rollout=3');
      expect(link).toContain('step=1');
    });

    it('emits index=0 for the first sample', () => {
      const { result } = renderHook(() => useUrlState());
      const link = result.current.generateLink({ file: 'test.jsonl', index: 0 });
      expect(link).toContain('index=0');
    });
  });
});
