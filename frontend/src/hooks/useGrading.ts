import { useState, useCallback, useEffect, useRef } from 'react';
import { LLM_PROVIDERS } from '../types';
import type { 
  GradeRequest, 
  GradeResponse, 
  GradeEntry, 
  PresetMetric, 
  LLMProvider,
  Sample,
  GradingReasoningEffort,
} from '../types';

type GradingStatus = 'idle' | 'connecting' | 'grading' | 'saving' | 'complete' | 'error' | 'cancelled';

interface GradingProgress {
  total: number;
  completed: number;
  errors: number;
  errorDetails: string[];  // Unique error messages from failed samples
  isRunning: boolean;
  status: GradingStatus;
  statusMessage: string;
  jobId: string | null;     // server-side job id (for reattach + cancel)
}

type SSEEvent = { type: string; [key: string]: unknown };

// Shared SSE reader: parse `data:` lines, invoke onEvent per event. Used by both
// the initial grade stream and the reattach stream. Comment/heartbeat lines and
// partial JSON are ignored; a non-syntax error thrown by onEvent propagates.
async function consumeSSE(
  response: Response,
  signal: AbortSignal | undefined,
  onEvent: (ev: SSEEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Failed to get response stream');
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (raw: string) => {
    try { onEvent(JSON.parse(raw) as SSEEvent); }
    catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  };
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) handle(line.slice(6));
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data: ')) handle(tail.slice(6));
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

// Sessionstorage key for the active job id (so a reload can rediscover it).
const ACTIVE_JOB_STORAGE_KEY = 'rollout_viz_active_grade_job';

interface StoredAPIKeys {
  [provider: string]: string;
}

const API_KEYS_STORAGE_KEY = 'rollout_viz_api_keys';
const PROVIDER_STORAGE_KEY = 'rollout_viz_last_provider';
const MODEL_STORAGE_KEY = 'rollout_viz_last_model';

export function useGrading(enabled = true) {
  const [progress, setProgress] = useState<GradingProgress>({
    total: 0,
    completed: 0,
    errors: 0,
    errorDetails: [],
    isRunning: false,
    status: 'idle',
    statusMessage: '',
    jobId: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [presetMetrics, setPresetMetrics] = useState<Record<string, PresetMetric>>({});
  
  // Server-side API keys availability (from .env)
  const [serverApiKeys, setServerApiKeys] = useState<Record<string, boolean>>({});
  
  // Load API keys from sessionStorage (tab-scoped, cleared on tab close)
  const [apiKeys, setApiKeys] = useState<StoredAPIKeys>(() => {
    try {
      const stored = sessionStorage.getItem(API_KEYS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  // Load last used provider/model
  const [lastProvider, setLastProvider] = useState<LLMProvider>(() => {
    return (sessionStorage.getItem(PROVIDER_STORAGE_KEY) as LLMProvider) || 'openai';
  });
  
  const [lastModel, setLastModel] = useState<string>(() => {
    return sessionStorage.getItem(MODEL_STORAGE_KEY) || LLM_PROVIDERS.openai.defaultModel;
  });

  // Abort controller for cancellation
  const abortControllerRef = useRef<AbortController | null>(null);
  // Current server-side job id (for cancel + reattach).
  const jobIdRef = useRef<string | null>(null);

  // Cancel current grading job. The job is server-side now, so cancellation
  // must hit the cancel endpoint (aborting the reader alone would leave the job
  // running). The reader is also aborted to stop tailing.
  const cancelGrading = useCallback(() => {
    const jobId = jobIdRef.current;
    if (jobId) {
      fetch(`/api/grade-jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => { /* best effort */ });
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    jobIdRef.current = null;
    try { sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY); } catch { /* ignore */ }
    setError(null);
    setProgress(prev => ({
      ...prev,
      isRunning: false,
      status: 'cancelled',
      statusMessage: 'Grading cancelled',
      jobId: null,
    }));
  }, []);

  // Save API keys to sessionStorage (tab-scoped)
  const saveApiKey = useCallback((provider: LLMProvider, key: string) => {
    setApiKeys(prev => {
      const updated = { ...prev, [provider]: key };
      sessionStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Get API key for a provider (returns empty string if using server-side key)
  const getApiKey = useCallback((provider: LLMProvider): string => {
    return apiKeys[provider] || '';
  }, [apiKeys]);

  // Check if we have an API key available (either local or server-side)
  const hasApiKeyAvailable = useCallback((provider: LLMProvider): boolean => {
    return !!(apiKeys[provider] || serverApiKeys[provider]);
  }, [apiKeys, serverApiKeys]);

  // Check if using server-side key for a provider
  const isUsingServerKey = useCallback((provider: LLMProvider): boolean => {
    return !apiKeys[provider] && !!serverApiKeys[provider];
  }, [apiKeys, serverApiKeys]);

  // Save last used provider
  const saveLastProvider = useCallback((provider: LLMProvider) => {
    setLastProvider(provider);
    sessionStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, []);

  // Save last used model
  const saveLastModel = useCallback((model: string) => {
    setLastModel(model);
    sessionStorage.setItem(MODEL_STORAGE_KEY, model);
  }, []);

  // Fetch preset metrics and server API key availability once authenticated
  useEffect(() => {
    if (!enabled) return;
    fetch('/api/preset-metrics')
      .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.json(); })
      .then(data => setPresetMetrics(data))
      .catch(err => console.error('Failed to load preset metrics:', err));

    fetch('/api/available-api-keys')
      .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.json(); })
      .then(data => setServerApiKeys(data))
      .catch(err => console.error('Failed to check server API keys:', err));
  }, [enabled]);

  // Grade samples using SSE for real-time progress
  const gradeSamples = useCallback(async (
    filePath: string,
    sampleIds: number[],
    metricName: string,
    metricPrompt: string,
    gradeType: 'float' | 'int' | 'bool' | 'freeform',
    provider: LLMProvider,
    model: string,
    parallelSize: number = 100,
    advancedSettings?: {
      temperature?: number;
      maxTokens?: number;
      reasoningEffort?: GradingReasoningEffort;
      topP?: number;
    },
    quoteSettings?: {
      requireQuotes?: boolean;
      maxQuoteRetries?: number;
    },
  ): Promise<GradeResponse | null> => {
    const apiKey = getApiKey(provider);
    const hasServerKey = serverApiKeys[provider];
    
    if (!apiKey && !hasServerKey) {
      setError(`No API key configured for ${provider}`);
      return null;
    }

    setError(null);
    
    // Create new abort controller for this request
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setProgress({
      total: sampleIds.length,
      completed: 0,
      errors: 0,
      errorDetails: [],
      isRunning: true,
      status: 'connecting',
      statusMessage: `Validating ${provider} connection...`,
      jobId: null,
    });

    try {
      // Pre-flight: validate API key + model before starting the full job
      const testResponse = await fetch('/api/test-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model,
          router_provider: 'litellm',
          ...(apiKey ? { api_key: apiKey } : {}),
        }),
        signal,
      });
      let testResult;
      try {
        testResult = await testResponse.json();
      } catch {
        throw new Error(`Pre-flight check failed: ${testResponse.status} ${testResponse.statusText}`);
      }
      if (!testResult.ok) {
        throw new Error(testResult.error || `Failed to connect to ${provider}`);
      }

      const request: GradeRequest = {
        file_path: filePath,
        sample_ids: sampleIds,
        metric_name: metricName,
        metric_prompt: metricPrompt,
        grade_type: gradeType,
        provider,
        model,
        router_provider: 'litellm',
        // Only include api_key if we have one locally, otherwise server uses .env
        ...(apiKey ? { api_key: apiKey } : {}),
        parallel_size: parallelSize,
        // Quote settings
        require_quotes: quoteSettings?.requireQuotes ?? true,
        max_quote_retries: quoteSettings?.maxQuoteRetries ?? 2,
        // Advanced settings
        ...(advancedSettings?.temperature !== undefined ? { temperature: advancedSettings.temperature } : {}),
        ...(advancedSettings?.maxTokens !== undefined ? { max_tokens: advancedSettings.maxTokens } : {}),
        ...(advancedSettings?.reasoningEffort !== undefined ? { reasoning_effort: advancedSettings.reasoningEffort } : {}),
        ...(advancedSettings?.topP !== undefined ? { top_p: advancedSettings.topP } : {}),
      };

      setProgress(prev => ({
        ...prev,
        status: 'grading',
        statusMessage: `Grading ${sampleIds.length} sample${sampleIds.length !== 1 ? 's' : ''} with ${model}...`,
      }));

      // Use SSE streaming endpoint for real-time progress
      const response = await fetch('/api/grade-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });

      if (!response.ok) {
        let detail = `Grading request failed: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          detail = errorData.detail || detail;
        } catch { /* response body not JSON */ }
        throw new Error(detail);
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response stream');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: GradeResponse | null = null;
      let errorCount = 0;
      let wasAborted = false;

      try {
        while (true) {
          // Check if aborted before reading
          if (signal.aborted) {
            wasAborted = true;
            break;
          }
          
          const { done, value } = await reader.read();
          
          if (done) {
            // Flush remaining decoder bytes
            buffer += decoder.decode();
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (lines starting with "data: ")
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const eventData = JSON.parse(line.slice(6));

                if (eventData.type === 'started') {
                  jobIdRef.current = eventData.job_id;
                  try { sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, eventData.job_id); } catch { /* ignore */ }
                  setProgress(prev => ({ ...prev, jobId: eventData.job_id, total: eventData.total ?? prev.total }));
                } else if (eventData.type === 'progress' || eventData.type === 'snapshot') {
                  errorCount = eventData.errors ?? errorCount;
                  setProgress(prev => ({
                    ...prev,
                    completed: eventData.completed,
                    total: eventData.total,
                    errors: errorCount,
                    statusMessage: `Grading... ${eventData.completed}/${eventData.total} samples`,
                  }));
                } else if (eventData.type === 'complete') {
                  errorCount = eventData.errors?.length || 0;
                  finalResult = {
                    graded_count: eventData.graded_count,
                    errors: eventData.errors || [],
                    grades: eventData.grades || {},
                  };
                } else if (eventData.type === 'error') {
                  throw new Error(eventData.message);
                }
              } catch (parseErr) {
                // Ignore JSON parse errors for partial data
                if (parseErr instanceof SyntaxError) continue;
                throw parseErr;
              }
            }
          }
        }

        // Process any remaining data in buffer after stream ends
        if (buffer.trim().startsWith('data: ')) {
          try {
            const eventData = JSON.parse(buffer.trim().slice(6));
            if (eventData.type === 'complete') {
              errorCount = eventData.errors?.length || 0;
              finalResult = {
                graded_count: eventData.graded_count,
                errors: eventData.errors || [],
                grades: eventData.grades || {},
              };
            } else if (eventData.type === 'error') {
              throw new Error(eventData.message);
            }
          } catch (parseErr) {
            if (!(parseErr instanceof SyntaxError)) throw parseErr;
          }
        }
      } catch (streamErr) {
        // Handle stream read errors (often happens on abort)
        if (signal.aborted || (streamErr instanceof Error && streamErr.name === 'AbortError')) {
          wasAborted = true;
        } else {
          throw streamErr;
        }
      } finally {
        // Always try to cancel the reader
        try {
          reader.cancel();
        } catch {
          // Ignore cancel errors
        }
      }

      // If aborted, return null without error
      if (wasAborted) {
        return null;
      }

      if (!finalResult) {
        throw new Error('Grading did not complete');
      }

      // Extract unique error messages for display
      const uniqueErrors = [...new Set(finalResult.errors.map(e => e.error))];

      // If ALL samples failed, surface the error prominently
      if (finalResult.graded_count === 0 && finalResult.errors.length > 0) {
        setError(`All ${finalResult.errors.length} samples failed: ${uniqueErrors[0]}`);
        setProgress({
          total: sampleIds.length,
          completed: 0,
          errors: finalResult.errors.length,
          errorDetails: uniqueErrors,
          isRunning: false,
          status: 'error',
          statusMessage: `All ${finalResult.errors.length} samples failed`,
          jobId: null,
        });
        return finalResult;
      }

      setProgress({
        total: sampleIds.length,
        completed: finalResult.graded_count,
        errors: finalResult.errors.length,
        errorDetails: uniqueErrors,
        isRunning: false,
        status: 'complete',
        statusMessage: `Graded ${finalResult.graded_count} sample${finalResult.graded_count !== 1 ? 's' : ''}${finalResult.errors.length > 0 ? ` (${finalResult.errors.length} error${finalResult.errors.length !== 1 ? 's' : ''})` : ''}`,
        jobId: null,
      });

      // Save preferences
      saveLastProvider(provider);
      saveLastModel(model);

      return finalResult;
    } catch (err) {
      // Check if this was an abort
      if (err instanceof Error && err.name === 'AbortError') {
        // Already handled by cancelGrading
        return null;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setProgress(prev => ({ 
        ...prev, 
        isRunning: false,
        status: 'error',
        statusMessage: 'Grading failed',
      }));
      return null;
    } finally {
      abortControllerRef.current = null;
      jobIdRef.current = null;
      try { sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [getApiKey, serverApiKeys, saveLastProvider, saveLastModel]);

  // Reattach to an already-running server-side job (e.g. after a page reload):
  // seed progress from the snapshot, then tail live progress to completion.
  const attachToJob = useCallback(async (jobId: string): Promise<void> => {
    jobIdRef.current = jobId;
    try { sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId); } catch { /* ignore */ }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    setError(null);
    setProgress(prev => ({
      ...prev, isRunning: true, status: 'grading', jobId,
      statusMessage: 'Reattaching to grading job...',
    }));
    try {
      const response = await fetch(`/api/grade-jobs/${jobId}/stream`, { signal });
      if (!response.ok) throw new Error(`Reattach failed: ${response.status}`);
      let errorCount = 0;
      let terminal: SSEEvent | null = null;
      await consumeSSE(response, signal, (ev) => {
        if (ev.type === 'snapshot' || ev.type === 'progress') {
          errorCount = (ev.errors as number) ?? errorCount;
          setProgress(prev => ({
            ...prev, isRunning: true, status: 'grading', jobId,
            completed: ev.completed as number, total: ev.total as number, errors: errorCount,
            statusMessage: `Grading... ${ev.completed}/${ev.total} samples`,
          }));
        } else if (ev.type === 'complete') {
          terminal = ev;
        } else if (ev.type === 'error') {
          throw new Error((ev.message as string) || 'Grading failed');
        }
      });
      if (terminal) {
        const ev = terminal as SSEEvent;
        const errs = (ev.errors as Array<{ error: string }>) || [];
        setProgress({
          total: (ev.total as number) ?? 0,
          completed: (ev.graded_count as number) ?? 0,
          errors: errs.length,
          errorDetails: [...new Set(errs.map(e => e.error))],
          isRunning: false,
          status: (ev.status as string) === 'cancelled' ? 'cancelled' : 'complete',
          statusMessage: (ev.status as string) === 'cancelled'
            ? `Cancelled — ${ev.graded_count} graded so far`
            : `Graded ${ev.graded_count} sample${ev.graded_count !== 1 ? 's' : ''}${errs.length ? ` (${errs.length} error${errs.length !== 1 ? 's' : ''})` : ''}`,
          jobId: null,
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Reattach failed');
      setProgress(prev => ({ ...prev, isRunning: false, status: 'error', statusMessage: 'Grading failed', jobId: null }));
    } finally {
      abortControllerRef.current = null;
      jobIdRef.current = null;
      try { sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY); } catch { /* ignore */ }
    }
  }, []);

  // List active/recent server-side jobs, optionally filtered to given files.
  const listGradeJobs = useCallback(async (filePaths?: string[]): Promise<Array<{ job_id: string; file_path: string; status: string; completed: number; total: number }>> => {
    try {
      const res = await fetch('/api/grade-jobs');
      if (!res.ok) return [];
      const jobs = await res.json();
      if (!filePaths || filePaths.length === 0) return jobs;
      const set = new Set(filePaths);
      return jobs.filter((j: { file_path: string }) => set.has(j.file_path));
    } catch {
      return [];
    }
  }, []);

  // Save graded samples to viz/ directory
  const saveGradedSamples = useCallback(async (
    filePath: string,
    grades: { [sampleId: number]: { [metricName: string]: GradeEntry } },
  ): Promise<boolean> => {
    try {
      const response = await fetch('/api/save-graded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_path: filePath,
          grades,
        }),
      });

      if (!response.ok) {
        let detail = `Failed to save grades: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          detail = errorData.detail || detail;
        } catch { /* response body not JSON */ }
        throw new Error(detail);
      }

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return false;
    }
  }, []);

  // Grade and save in one operation
  const gradeAndSave = useCallback(async (
    filePath: string,
    sampleIds: number[],
    metricName: string,
    metricPrompt: string,
    gradeType: 'float' | 'int' | 'bool' | 'freeform',
    provider: LLMProvider,
    model: string,
    parallelSize: number = 100,
    advancedSettings?: {
      temperature?: number;
      maxTokens?: number;
      reasoningEffort?: GradingReasoningEffort;
      topP?: number;
    },
    quoteSettings?: {
      requireQuotes?: boolean;
      maxQuoteRetries?: number;
    },
  ): Promise<GradeResponse | null> => {
    // Grades are now persisted incrementally server-side (the job writes to
    // viz/ as it goes), so there is no separate client-side save step — the
    // final progress state is set by gradeSamples itself.
    return gradeSamples(
      filePath,
      sampleIds,
      metricName,
      metricPrompt,
      gradeType,
      provider,
      model,
      parallelSize,
      advancedSettings,
      quoteSettings,
    );
  }, [gradeSamples]);

  // Get latest grade for a sample and metric
  const getLatestGrade = useCallback((
    sample: Sample,
    metricName: string,
  ): GradeEntry | null => {
    if (!sample.grades || !sample.grades[metricName]) {
      return null;
    }
    const grades = sample.grades[metricName];
    return grades.length > 0 ? grades[grades.length - 1] : null;
  }, []);

  // Check if a sample has any grades
  const hasGrades = useCallback((sample: Sample): boolean => {
    return !!sample.grades && Object.keys(sample.grades).length > 0;
  }, []);

  // Save a custom metric as a preset
  const saveCustomMetric = useCallback(async (
    name: string,
    description: string,
    gradeType: 'float' | 'int' | 'bool' | 'freeform',
    prompt: string,
    keyOverride?: string,
  ): Promise<boolean> => {
    try {
      const key = keyOverride ?? name.toLowerCase().replace(/\s+/g, '_');
      const response = await fetch('/api/save-custom-metric', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          name,
          description,
          grade_type: gradeType,
          prompt,
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to save metric');
      }
      
      // Refresh preset metrics
      const metricsResponse = await fetch('/api/preset-metrics');
      const metrics = await metricsResponse.json();
      setPresetMetrics(metrics);
      
      return true;
    } catch (err) {
      console.error('Failed to save custom metric:', err);
      setError(err instanceof Error ? err.message : 'Failed to save custom metric');
      return false;
    }
  }, []);

  // Delete a custom metric
  const deleteCustomMetric = useCallback(async (key: string): Promise<boolean> => {
    try {
      const response = await fetch(`/api/custom-metric/${key}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to delete metric');
      }
      
      // Refresh preset metrics
      const metricsResponse = await fetch('/api/preset-metrics');
      const metrics = await metricsResponse.json();
      setPresetMetrics(metrics);
      
      return true;
    } catch (err) {
      console.error('Failed to delete custom metric:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete custom metric');
      return false;
    }
  }, []);

  return {
    // State
    progress,
    error,
    presetMetrics,
    apiKeys,
    serverApiKeys,
    lastProvider,
    lastModel,
    
    // Actions
    gradeSamples,
    saveGradedSamples,
    gradeAndSave,
    attachToJob,
    listGradeJobs,
    cancelGrading,
    saveApiKey,
    getApiKey,
    hasApiKeyAvailable,
    isUsingServerKey,
    saveLastProvider,
    saveLastModel,
    
    // Utilities
    getLatestGrade,
    hasGrades,
    
    // Custom metrics
    saveCustomMetric,
    deleteCustomMetric,
    
    // Clear error
    clearError: () => setError(null),
  };
}
