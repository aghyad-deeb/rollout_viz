import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useApi } from './useApi';

// Helper to create a deferred promise for controlling fetch timing
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFetchResponse(data: object): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as Response;
}

function makeSamplesResponse(count: number, filePath = 'test.jsonl') {
  return {
    samples: Array.from({ length: count }, (_, i) => ({
      id: i,
      messages: [{ role: 'user', content: `Q${i}` }],
      attributes: { step: i, rollout_n: i, reward: 0 },
      timestamp: '',
    })),
    total: count,
    experiment_name: 'test',
    file_path: filePath,
  };
}

function makeBatchResponse(filePaths: string[], samplesPerFile = 2) {
  let nextId = 0;
  const allSamples = filePaths.flatMap((fp) =>
    Array.from({ length: samplesPerFile }, (_, i) => ({
      id: nextId++,
      messages: [{ role: 'user', content: `Q${nextId - 1}` }],
      attributes: { step: i, rollout_n: i, reward: 0, source_file: fp },
      timestamp: '',
    }))
  );
  return {
    samples: allSamples,
    total: allSamples.length,
    file_results: filePaths.map((fp) => ({ file: fp, count: samplesPerFile })),
    experiment_names: ['test'],
    errors: [],
  };
}

describe('useApi - stale request cancellation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts previous request when a new loadSamples call is made', async () => {
    const deferred1 = createDeferred<Response>();
    const deferred2 = createDeferred<Response>();
    const abortedSignals: boolean[] = [];

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit)?.signal;
      callCount++;
      if (callCount === 1) {
        // Track if first request's signal gets aborted
        if (signal) {
          signal.addEventListener('abort', () => abortedSignals.push(true));
        }
        return deferred1.promise;
      }
      return deferred2.promise;
    });

    const { result } = renderHook(() => useApi());

    // Start first load
    act(() => {
      result.current.loadSamples('file1.jsonl');
    });

    // Start second load before first resolves — should abort first
    let promise2: Promise<unknown>;
    act(() => {
      promise2 = result.current.loadSamples('file2.jsonl');
    });

    // First request's signal should be aborted
    expect(abortedSignals.length).toBe(1);

    // Resolve second request
    deferred2.resolve(makeFetchResponse(makeSamplesResponse(5, 'file2.jsonl')));
    await act(async () => {
      await promise2!;
    });

    expect(result.current.error).toBeNull();
  });

  it('does not set error when a request is aborted', async () => {
    const deferred = createDeferred<Response>();

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit)?.signal;
      // Simulate an abort by rejecting when signal fires
      return new Promise<Response>((resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
        deferred.promise.then(resolve, reject);
      });
    });

    const { result } = renderHook(() => useApi());

    // Start a load
    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.loadSamples('file1.jsonl');
    });

    // Start a second load — aborts the first
    act(() => {
      result.current.loadSamples('file2.jsonl');
    });

    // Wait for the aborted promise to settle
    await act(async () => {
      await promise!.catch(() => {});
    });

    // Error should NOT be set for the aborted request
    expect(result.current.error).toBeNull();
  });

  it('aborts previous request when a new loadMultipleSamples call is made', async () => {
    const abortedSignals: boolean[] = [];
    const deferred1 = createDeferred<Response>();
    const deferred2 = createDeferred<Response>();

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit)?.signal;
      callCount++;
      if (callCount === 1) {
        if (signal) {
          signal.addEventListener('abort', () => abortedSignals.push(true));
        }
        return deferred1.promise;
      }
      return deferred2.promise;
    });

    const { result } = renderHook(() => useApi());

    // Start first multi-load
    act(() => {
      result.current.loadMultipleSamples(['file1.jsonl']);
    });

    // Start second multi-load — should abort first
    let promise2: Promise<unknown>;
    act(() => {
      promise2 = result.current.loadMultipleSamples(['file2.jsonl']);
    });

    expect(abortedSignals.length).toBe(1);

    // Resolve second with batch response format
    deferred2.resolve(makeFetchResponse(makeBatchResponse(['file2.jsonl'], 3)));
    await act(async () => {
      await promise2!;
    });

    expect(result.current.error).toBeNull();
  });
});

describe('useApi - two-phase loading', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loadFilesProgressively sends metadata_only: true per file', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse(makeBatchResponse(['a.jsonl'], 2))
    );

    const { result } = renderHook(() => useApi());
    const onFileLoaded = vi.fn();

    await act(async () => {
      await result.current.loadFilesProgressively(['a.jsonl', 'b.jsonl'], onFileLoaded);
    });

    // Should fire one request per file
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      const [, opts] = call;
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.metadata_only).toBe(true);
      expect(body.files).toHaveLength(1);
    }
    // onFileLoaded called for each file
    expect(onFileLoaded).toHaveBeenCalledTimes(2);
  });

  it('loadMultipleSamplesFull sends request without metadata_only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse(makeBatchResponse(['a.jsonl'], 2))
    );

    const { result } = renderHook(() => useApi());

    await act(async () => {
      await result.current.loadMultipleSamplesFull(['a.jsonl']);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.metadata_only).toBeUndefined();
  });

  it('loadSingleSample calls GET /api/sample/{id}', async () => {
    const sampleData = {
      id: 3,
      messages: [{ role: 'user', content: 'hi' }],
      message_count: 1,
      attributes: { step: 0, rollout_n: 0, reward: 0 },
      timestamp: '',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse(sampleData)
    );

    const { result } = renderHook(() => useApi());

    await act(async () => {
      await result.current.loadSingleSample(3, 'test.jsonl');
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/api/sample/3');
    expect(url).toContain('file=test.jsonl');
  });

  it('messagesLoaded starts as false', () => {
    const { result } = renderHook(() => useApi());
    expect(result.current.messagesLoaded).toBe(false);
  });

  it('messagesLoaded is true after loadMultipleSamplesFull', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse(makeBatchResponse(['a.jsonl'], 2))
    );

    const { result } = renderHook(() => useApi());

    await act(async () => {
      await result.current.loadMultipleSamplesFull(['a.jsonl']);
    });

    expect(result.current.messagesLoaded).toBe(true);
  });

  it('messagesLoaded resets to false on loadFilesProgressively', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse(makeBatchResponse(['a.jsonl'], 2))
    );

    const { result } = renderHook(() => useApi());

    // First do a full load
    await act(async () => {
      await result.current.loadMultipleSamplesFull(['a.jsonl']);
    });
    expect(result.current.messagesLoaded).toBe(true);

    // Then progressive load resets it
    await act(async () => {
      await result.current.loadFilesProgressively(['a.jsonl'], vi.fn());
    });
    expect(result.current.messagesLoaded).toBe(false);
  });

  it('progressive load aborts any in-flight background full load', async () => {
    const abortedSignals: boolean[] = [];
    const deferred1 = createDeferred<Response>();
    const deferred2 = createDeferred<Response>();

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit)?.signal;
      callCount++;
      if (callCount === 1) {
        if (signal) {
          signal.addEventListener('abort', () => abortedSignals.push(true));
        }
        return deferred1.promise;
      }
      return deferred2.promise;
    });

    const { result } = renderHook(() => useApi());

    // Start a full load
    act(() => {
      result.current.loadMultipleSamplesFull(['a.jsonl']);
    });

    // Start a progressive load — should abort the full load
    act(() => {
      result.current.loadFilesProgressively(['b.jsonl'], vi.fn());
    });

    expect(abortedSignals.length).toBe(1);
  });
});

describe('useApi - batch endpoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loadMultipleSamples sends POST to /api/samples/batch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse(makeBatchResponse(['a.jsonl', 'b.jsonl'], 2))
    );

    const { result } = renderHook(() => useApi());

    let response: unknown;
    await act(async () => {
      response = await result.current.loadMultipleSamples(['a.jsonl', 'b.jsonl']);
    });

    // Should call fetch once with POST to /api/samples/batch
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/samples/batch');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.files).toEqual(['a.jsonl', 'b.jsonl']);

    // Should return combined data
    const res = response as { samples: unknown[]; total: number };
    expect(res.total).toBe(4);
    expect(res.samples).toHaveLength(4);
  });

  it('batch abort cancels the request', async () => {
    const deferred = createDeferred<Response>();
    const abortedSignals: boolean[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit)?.signal;
      if (signal) {
        signal.addEventListener('abort', () => abortedSignals.push(true));
      }
      return deferred.promise;
    });

    const { result } = renderHook(() => useApi());

    // Start batch load
    act(() => {
      result.current.loadMultipleSamples(['a.jsonl', 'b.jsonl']);
    });

    // Start another load to abort the first
    act(() => {
      result.current.loadMultipleSamples(['c.jsonl']);
    });

    expect(abortedSignals.length).toBe(1);
  });
});
