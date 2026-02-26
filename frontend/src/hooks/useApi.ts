import { useState, useCallback, useRef } from 'react';
import type { Sample, FileInfo } from '../types';

const FETCH_TIMEOUT = 30_000; // 30 seconds

function fetchWithTimeout(url: string, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Combine external signal (cross-call cancellation) with timeout signal
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  return fetch(url, { signal: combinedSignal }).finally(() => clearTimeout(timer));
}

interface SamplesResponse {
  samples: Sample[];
  total: number;
  experiment_name: string;
  file_path: string;
}

interface MultiFileSamplesResponse {
  samples: Sample[];
  total: number;
  experiment_name: string;
  file_paths: string[];
}

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const samplesAbortRef = useRef<AbortController | null>(null);
  const backgroundAbortRef = useRef<AbortController | null>(null);

  const loadSamples = useCallback(async (filePath: string): Promise<SamplesResponse | null> => {
    // Abort any in-flight samples request
    samplesAbortRef.current?.abort();
    const controller = new AbortController();
    samplesAbortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const response = await fetchWithTimeout(
        `/api/samples?file=${encodeURIComponent(filePath)}`,
        controller.signal,
      );
      if (!response.ok) {
        let detail = `Failed to load samples: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          detail = errorData.detail || detail;
        } catch { /* response body not JSON */ }
        throw new Error(detail);
      }
      const data = await response.json();
      return data;
    } catch (err) {
      // Silently return null for aborted requests (user switched files)
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (controller.signal.aborted) {
          return null;
        }
        setError('Request timed out — server may be starting up. Try refreshing.');
        return null;
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      return null;
    } finally {
      // Only clear loading if this is still the active request
      if (samplesAbortRef.current === controller) {
        setLoading(false);
      }
    }
  }, []);

  // Load multiple files via batch endpoint (single request, server-side concurrency)
  const loadMultipleSamples = useCallback(async (filePaths: string[]): Promise<MultiFileSamplesResponse | null> => {
    if (filePaths.length === 0) return null;

    // Abort any in-flight samples request
    samplesAbortRef.current?.abort();
    const controller = new AbortController();
    samplesAbortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), 60_000); // 60s for batch
      const combinedSignal = AbortSignal.any([controller.signal, timeoutController.signal]);

      const response = await fetch('/api/samples/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filePaths }),
        signal: combinedSignal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        let detail = `Failed to load samples: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          detail = errorData.detail || detail;
        } catch { /* response body not JSON */ }
        throw new Error(detail);
      }

      const data = await response.json();

      // Server returns combined samples with IDs and source_file already set
      const experimentNames: string[] = data.experiment_names || [];
      const experimentName = experimentNames.length === 1
        ? experimentNames[0]
        : experimentNames.length > 1
          ? `${experimentNames.length} experiments`
          : '';

      return {
        samples: data.samples,
        total: data.total,
        experiment_name: experimentName,
        file_paths: filePaths,
      };
    } catch (err) {
      // Silently return null for aborted requests
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (controller.signal.aborted) {
          return null;
        }
        setError('Request timed out — server may be starting up. Try refreshing.');
        return null;
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      return null;
    } finally {
      if (samplesAbortRef.current === controller) {
        setLoading(false);
      }
    }
  }, []);

  // Progressive per-file metadata loading: fire individual requests per file,
  // call onFileLoaded as each completes. Clears loading spinner after first file.
  // Returns experiment name string when all files are done.
  const loadFilesProgressively = useCallback(async (
    filePaths: string[],
    onFileLoaded: (samples: Sample[], filePath: string) => void,
  ): Promise<{ experimentName: string } | null> => {
    if (filePaths.length === 0) return null;

    // Abort any in-flight requests (both metadata and background full loads)
    samplesAbortRef.current?.abort();
    backgroundAbortRef.current?.abort();
    const controller = new AbortController();
    samplesAbortRef.current = controller;

    setLoading(true);
    setError(null);
    setMessagesLoaded(false);

    const experimentNames = new Set<string>();
    let firstDone = false;
    let hadError = false;

    // Fire all requests in parallel — each resolves independently
    const filePromises = filePaths.map(async (filePath) => {
      try {
        const timeoutController = new AbortController();
        const timer = setTimeout(() => timeoutController.abort(), 60_000);
        const combinedSignal = AbortSignal.any([controller.signal, timeoutController.signal]);

        const response = await fetch('/api/samples/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [filePath], metadata_only: true }),
          signal: combinedSignal,
        });
        clearTimeout(timer);

        if (controller.signal.aborted) return;
        if (!response.ok) {
          hadError = true;
          return;
        }

        const data = await response.json();
        if (controller.signal.aborted) return;

        // Collect experiment names
        const expNames: string[] = data.experiment_names || [];
        expNames.forEach((n: string) => experimentNames.add(n));

        // Clear loading spinner after first file arrives
        if (!firstDone) {
          firstDone = true;
          if (samplesAbortRef.current === controller) {
            setLoading(false);
          }
        }

        // Notify caller with this file's samples
        onFileLoaded(data.samples, filePath);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        hadError = true;
        console.error(`Failed to load ${filePath}:`, err);
      }
    });

    await Promise.allSettled(filePromises);

    if (controller.signal.aborted) return null;

    // Ensure loading is cleared even if all files failed
    if (samplesAbortRef.current === controller) {
      setLoading(false);
    }

    if (hadError && !firstDone) {
      setError('Some files failed to load');
    }

    const experimentName = experimentNames.size === 1
      ? [...experimentNames][0]
      : experimentNames.size > 1
        ? `${experimentNames.size} experiments`
        : '';

    return { experimentName };
  }, []);

  // Load full samples with messages — second phase of two-phase loading (background)
  const loadMultipleSamplesFull = useCallback(async (filePaths: string[]): Promise<MultiFileSamplesResponse | null> => {
    if (filePaths.length === 0) return null;

    // Abort any previous background full load
    backgroundAbortRef.current?.abort();
    const controller = new AbortController();
    backgroundAbortRef.current = controller;

    setMessagesLoading(true);

    try {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), 120_000); // 2 min for full load
      const combinedSignal = AbortSignal.any([controller.signal, timeoutController.signal]);

      const response = await fetch('/api/samples/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filePaths }),
        signal: combinedSignal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        let detail = `Failed to load samples: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          detail = errorData.detail || detail;
        } catch { /* response body not JSON */ }
        throw new Error(detail);
      }

      const data = await response.json();
      const experimentNames: string[] = data.experiment_names || [];
      const experimentName = experimentNames.length === 1
        ? experimentNames[0]
        : experimentNames.length > 1
          ? `${experimentNames.length} experiments`
          : '';

      setMessagesLoaded(true);
      return {
        samples: data.samples,
        total: data.total,
        experiment_name: experimentName,
        file_paths: filePaths,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return null;
      }
      // Don't set main error for background load failures
      console.error('Background full load failed:', err);
      return null;
    } finally {
      if (backgroundAbortRef.current === controller) {
        setMessagesLoading(false);
      }
    }
  }, []);

  // Load a single sample by ID (for on-demand message hydration)
  const loadSingleSample = useCallback(async (sampleId: number, filePath: string): Promise<Sample | null> => {
    try {
      const response = await fetchWithTimeout(
        `/api/sample/${sampleId}?file=${encodeURIComponent(filePath)}`,
      );
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch {
      return null;
    }
  }, []);

  const listLocalFiles = useCallback(async (directory: string): Promise<FileInfo[]> => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetchWithTimeout(`/api/files/local?directory=${encodeURIComponent(directory)}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to list files');
      }
      return await response.json();
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'AbortError'
        ? 'Request timed out — server may be starting up. Try refreshing.'
        : err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const listS3Files = useCallback(async (bucket: string, prefix: string): Promise<FileInfo[]> => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetchWithTimeout(`/api/files/s3?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to list S3 files');
      }
      return await response.json();
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'AbortError'
        ? 'Request timed out — server may be starting up. Try refreshing.'
        : err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    messagesLoaded,
    messagesLoading,
    loadSamples,
    loadMultipleSamples,
    loadFilesProgressively,
    loadMultipleSamplesFull,
    loadSingleSample,
    listLocalFiles,
    listS3Files,
  };
}
