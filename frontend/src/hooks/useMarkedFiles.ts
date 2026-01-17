import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'rollout-visualizer-marked-files';

export function useMarkedFiles() {
  const [markedFiles, setMarkedFiles] = useState<Set<string>>(() => {
    // Initialize from localStorage
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set(parsed);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
    return new Set();
  });

  // Persist to localStorage whenever markedFiles changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...markedFiles]));
    } catch {
      // Ignore localStorage errors
    }
  }, [markedFiles]);

  const toggleMark = useCallback((filePath: string) => {
    setMarkedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const markFile = useCallback((filePath: string) => {
    setMarkedFiles((prev) => {
      const next = new Set(prev);
      next.add(filePath);
      return next;
    });
  }, []);

  const unmarkFile = useCallback((filePath: string) => {
    setMarkedFiles((prev) => {
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
  }, []);

  const clearAllMarks = useCallback(() => {
    setMarkedFiles(new Set());
  }, []);

  const isMarked = useCallback((filePath: string) => {
    return markedFiles.has(filePath);
  }, [markedFiles]);

  return {
    markedFiles,
    toggleMark,
    markFile,
    unmarkFile,
    clearAllMarks,
    isMarked,
  };
}
