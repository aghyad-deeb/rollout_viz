import { useState, useCallback, useEffect, useRef } from 'react';
import type { 
  GradeRequest, 
  GradeResponse, 
  GradeEntry, 
  PresetMetric, 
  LLMProvider,
  Sample,
} from '../types';

type GradingStatus = 'idle' | 'connecting' | 'grading' | 'saving' | 'complete' | 'error' | 'cancelled';

interface GradingProgress {
  total: number;
  completed: number;
  errors: number;
  isRunning: boolean;
  status: GradingStatus;
  statusMessage: string;
}

interface StoredAPIKeys {
  [provider: string]: string;
}

const API_KEYS_STORAGE_KEY = 'rollout_viz_api_keys';
const PROVIDER_STORAGE_KEY = 'rollout_viz_last_provider';
const MODEL_STORAGE_KEY = 'rollout_viz_last_model';

export function useGrading() {
  const [progress, setProgress] = useState<GradingProgress>({
    total: 0,
    completed: 0,
    errors: 0,
    isRunning: false,
    status: 'idle',
    statusMessage: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [presetMetrics, setPresetMetrics] = useState<Record<string, PresetMetric>>({});
  
  // Server-side API keys availability (from .env)
  const [serverApiKeys, setServerApiKeys] = useState<Record<string, boolean>>({});
  
  // Load API keys from localStorage
  const [apiKeys, setApiKeys] = useState<StoredAPIKeys>(() => {
    try {
      const stored = localStorage.getItem(API_KEYS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  // Load last used provider/model
  const [lastProvider, setLastProvider] = useState<LLMProvider>(() => {
    return (localStorage.getItem(PROVIDER_STORAGE_KEY) as LLMProvider) || 'openai';
  });
  
  const [lastModel, setLastModel] = useState<string>(() => {
    return localStorage.getItem(MODEL_STORAGE_KEY) || 'gpt-4o';
  });

  // Abort controller for cancellation
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cancel current grading job
  const cancelGrading = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setProgress(prev => ({
      ...prev,
      isRunning: false,
      status: 'cancelled',
      statusMessage: 'Grading cancelled',
    }));
  }, []);

  // Save API keys to localStorage
  const saveApiKey = useCallback((provider: LLMProvider, key: string) => {
    setApiKeys(prev => {
      const updated = { ...prev, [provider]: key };
      localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(updated));
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
    localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, []);

  // Save last used model
  const saveLastModel = useCallback((model: string) => {
    setLastModel(model);
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  }, []);

  // Fetch preset metrics and server API key availability on mount
  useEffect(() => {
    fetch('/api/preset-metrics')
      .then(res => res.json())
      .then(data => setPresetMetrics(data))
      .catch(err => console.error('Failed to load preset metrics:', err));
    
    fetch('/api/available-api-keys')
      .then(res => res.json())
      .then(data => setServerApiKeys(data))
      .catch(err => console.error('Failed to check server API keys:', err));
  }, []);

  // Grade samples
  const gradeSamples = useCallback(async (
    filePath: string,
    sampleIds: number[],
    metricName: string,
    metricPrompt: string,
    gradeType: 'float' | 'int' | 'bool',
    provider: LLMProvider,
    model: string,
    parallelSize: number = 100,
    advancedSettings?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
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
      isRunning: true,
      status: 'connecting',
      statusMessage: `Connecting to ${provider}...`,
    });

    try {
      const request: GradeRequest = {
        file_path: filePath,
        sample_ids: sampleIds,
        metric_name: metricName,
        metric_prompt: metricPrompt,
        grade_type: gradeType,
        provider,
        model,
        // Only include api_key if we have one locally, otherwise server uses .env
        ...(apiKey ? { api_key: apiKey } : {}),
        parallel_size: parallelSize,
        // Advanced settings
        ...(advancedSettings?.temperature !== undefined ? { temperature: advancedSettings.temperature } : {}),
        ...(advancedSettings?.maxTokens !== undefined ? { max_tokens: advancedSettings.maxTokens } : {}),
        ...(advancedSettings?.topP !== undefined ? { top_p: advancedSettings.topP } : {}),
      };

      setProgress(prev => ({
        ...prev,
        status: 'grading',
        statusMessage: `Grading ${sampleIds.length} sample${sampleIds.length !== 1 ? 's' : ''} with ${model}...`,
      }));

      const response = await fetch('/api/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to grade samples');
      }

      const data: GradeResponse = await response.json();
      
      setProgress({
        total: sampleIds.length,
        completed: data.graded_count,
        errors: data.errors.length,
        isRunning: false,
        status: 'complete',
        statusMessage: `Graded ${data.graded_count} sample${data.graded_count !== 1 ? 's' : ''}${data.errors.length > 0 ? ` (${data.errors.length} error${data.errors.length !== 1 ? 's' : ''})` : ''}`,
      });

      // Save preferences
      saveLastProvider(provider);
      saveLastModel(model);

      return data;
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
    }
  }, [getApiKey, serverApiKeys, saveLastProvider, saveLastModel]);

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
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to save grades');
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
    gradeType: 'float' | 'int' | 'bool',
    provider: LLMProvider,
    model: string,
    parallelSize: number = 100,
    advancedSettings?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
    },
  ): Promise<GradeResponse | null> => {
    const gradeResult = await gradeSamples(
      filePath,
      sampleIds,
      metricName,
      metricPrompt,
      gradeType,
      provider,
      model,
      parallelSize,
      advancedSettings,
    );

    if (!gradeResult || gradeResult.graded_count === 0) {
      return gradeResult;
    }

    // Show saving status
    setProgress(prev => ({
      ...prev,
      isRunning: true,
      status: 'saving',
      statusMessage: 'Saving grades to file...',
    }));

    // Convert grades to the save format
    const gradesToSave: { [sampleId: number]: { [metricName: string]: GradeEntry } } = {};
    for (const [sampleIdStr, grade] of Object.entries(gradeResult.grades)) {
      const sampleId = parseInt(sampleIdStr, 10);
      gradesToSave[sampleId] = { [metricName]: grade };
    }

    const saved = await saveGradedSamples(filePath, gradesToSave);
    if (!saved) {
      setError('Grades computed but failed to save');
      setProgress(prev => ({
        ...prev,
        isRunning: false,
        status: 'error',
        statusMessage: 'Failed to save grades',
      }));
    } else {
      setProgress(prev => ({
        ...prev,
        isRunning: false,
        status: 'complete',
        statusMessage: `Successfully graded and saved ${gradeResult.graded_count} sample${gradeResult.graded_count !== 1 ? 's' : ''}!`,
      }));
    }

    return gradeResult;
  }, [gradeSamples, saveGradedSamples]);

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
    
    // Clear error
    clearError: () => setError(null),
  };
}
