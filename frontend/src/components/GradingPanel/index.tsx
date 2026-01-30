import { useState, useMemo } from 'react';
import type { LLMProvider } from '../../types';
import { LLM_PROVIDERS } from '../../types';
import type { useGrading } from '../../hooks/useGrading';

interface GradingPanelProps {
  filteredSampleIds: number[];
  filePath: string;
  isDarkMode: boolean;
  onGradingComplete: () => void; // Callback to refresh samples after grading
  grading: ReturnType<typeof useGrading>; // Grading state from parent
}

export function GradingPanel({
  filteredSampleIds,
  filePath,
  isDarkMode,
  onGradingComplete,
  grading,
}: GradingPanelProps) {
  const {
    progress,
    error,
    presetMetrics,
    lastProvider,
    lastModel,
    gradeAndSave,
    cancelGrading,
    saveApiKey,
    hasApiKeyAvailable,
    isUsingServerKey,
    saveLastProvider,
    saveLastModel,
    saveCustomMetric,
    deleteCustomMetric,
    clearError,
  } = grading;

  // Form state
  const [selectedMetric, setSelectedMetric] = useState<string>('helpfulness');
  const [customMetricName, setCustomMetricName] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [savingMetric, setSavingMetric] = useState(false);
  const [gradeType, setGradeType] = useState<'float' | 'int' | 'bool'>('float');
  const [provider, setProvider] = useState<LLMProvider>(lastProvider);
  const [model, setModel] = useState<string>(lastModel);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [parallelSize, setParallelSize] = useState(100);
  const [requireQuotes, setRequireQuotes] = useState(false); // Disabled by default for speed
  
  // Advanced settings
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [temperature, setTemperature] = useState<number | undefined>(undefined);
  const [maxTokens, setMaxTokens] = useState<number | undefined>(undefined);
  const [topP, setTopP] = useState<number | undefined>(undefined);

  // Check if we have a valid API key (local or server-side)
  const hasApiKey = useMemo(() => {
    return hasApiKeyAvailable(provider);
  }, [hasApiKeyAvailable, provider]);

  // Check if using server-side key
  const usingServerKey = useMemo(() => {
    return isUsingServerKey(provider);
  }, [isUsingServerKey, provider]);

  // Get the current metric info
  const currentMetric = useMemo(() => {
    if (selectedMetric === 'custom') {
      return {
        name: customMetricName || 'custom',
        prompt: customPrompt,
        grade_type: gradeType,
      };
    }
    return presetMetrics[selectedMetric];
  }, [selectedMetric, customMetricName, customPrompt, gradeType, presetMetrics]);

  // Handle provider change
  const handleProviderChange = (newProvider: LLMProvider) => {
    setProvider(newProvider);
    saveLastProvider(newProvider);
    // Reset model to provider's default
    setModel(LLM_PROVIDERS[newProvider].defaultModel);
    saveLastModel(LLM_PROVIDERS[newProvider].defaultModel);
  };

  // Handle model change
  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    saveLastModel(newModel);
  };

  // Save API key
  const handleSaveApiKey = () => {
    if (apiKeyInput.trim()) {
      saveApiKey(provider, apiKeyInput.trim());
      setApiKeyInput('');
    }
  };

  // Start grading
  const handleGrade = async () => {
    if (!currentMetric || !filePath || filteredSampleIds.length === 0) return;

    const advancedSettings = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(topP !== undefined ? { topP } : {}),
    };

    const quoteSettings = {
      requireQuotes,
      maxQuoteRetries: 2,
    };

    const result = await gradeAndSave(
      filePath,
      filteredSampleIds,
      selectedMetric === 'custom' ? customMetricName : selectedMetric,
      currentMetric.prompt,
      currentMetric.grade_type as 'float' | 'int' | 'bool',
      provider,
      model,
      parallelSize,
      Object.keys(advancedSettings).length > 0 ? advancedSettings : undefined,
      quoteSettings,
    );

    if (result && result.graded_count > 0) {
      onGradingComplete();
    }
  };

  // Styles
  const bgClass = isDarkMode ? 'bg-gray-800' : 'bg-white';
  const borderClass = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const textClass = isDarkMode ? 'text-gray-200' : 'text-gray-800';
  const mutedClass = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const inputClass = isDarkMode 
    ? 'bg-gray-700 border-gray-600 text-gray-200 placeholder-gray-500' 
    : 'bg-white border-gray-300 text-gray-800';

  return (
    <div className={`p-4 rounded-lg border ${bgClass} ${borderClass} space-y-4`}>
      <h3 className={`font-semibold ${textClass} flex items-center gap-2`}>
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>rate_review</span>
        LLM Grading
      </h3>

      {/* Error display */}
      {error && (
        <div className="p-3 rounded-lg bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700">
          <div className="flex items-center justify-between">
            <span className="text-red-700 dark:text-red-300 text-sm">{error}</span>
            <button onClick={clearError} className="text-red-500 hover:text-red-700">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>
        </div>
      )}

      {/* Metric selection */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${textClass}`}>Metric</label>
        <div className="flex gap-2">
          <select
            value={selectedMetric}
            onChange={(e) => setSelectedMetric(e.target.value)}
            className={`flex-1 px-3 py-2 rounded border text-sm ${inputClass}`}
          >
            <optgroup label="Built-in Metrics">
              {Object.entries(presetMetrics)
                .filter(([, metric]) => !metric.is_custom)
                .map(([key, metric]) => (
                  <option key={key} value={key}>{metric.name}</option>
                ))}
            </optgroup>
            {Object.entries(presetMetrics).some(([, m]) => m.is_custom) && (
              <optgroup label="Saved Custom Metrics">
                {Object.entries(presetMetrics)
                  .filter(([, metric]) => metric.is_custom)
                  .map(([key, metric]) => (
                    <option key={key} value={key}>{metric.name}</option>
                  ))}
              </optgroup>
            )}
            <option value="custom">+ New Custom...</option>
          </select>
          {/* Delete button for custom metrics */}
          {selectedMetric !== 'custom' && presetMetrics[selectedMetric]?.is_custom && (
            <button
              onClick={async () => {
                if (confirm(`Delete custom metric "${presetMetrics[selectedMetric].name}"?`)) {
                  await deleteCustomMetric(selectedMetric);
                  setSelectedMetric('helpfulness');
                }
              }}
              className="px-2 py-1 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30"
              title="Delete custom metric"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
            </button>
          )}
        </div>

        {/* Preset metric description */}
        {selectedMetric !== 'custom' && presetMetrics[selectedMetric] && (
          <p className={`text-xs ${mutedClass}`}>
            {presetMetrics[selectedMetric].description}
            <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
              {presetMetrics[selectedMetric].grade_type}
            </span>
            {presetMetrics[selectedMetric].is_custom && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                custom
              </span>
            )}
          </p>
        )}

        {/* Custom metric fields */}
        {selectedMetric === 'custom' && (
          <div className="space-y-2 p-3 rounded border border-dashed border-gray-300 dark:border-gray-600">
            <input
              type="text"
              value={customMetricName}
              onChange={(e) => setCustomMetricName(e.target.value)}
              placeholder="Metric name..."
              className={`w-full px-3 py-2 rounded border text-sm ${inputClass}`}
            />
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Enter your grading prompt..."
              rows={4}
              className={`w-full px-3 py-2 rounded border text-sm ${inputClass}`}
            />
            <div className="flex gap-2 items-center">
              <label className={`text-xs ${mutedClass}`}>Grade type:</label>
              <select
                value={gradeType}
                onChange={(e) => setGradeType(e.target.value as 'float' | 'int' | 'bool')}
                className={`px-2 py-1 rounded border text-xs ${inputClass}`}
              >
                <option value="float">Float (0-1)</option>
                <option value="int">Integer</option>
                <option value="bool">Boolean</option>
              </select>
            </div>
            {/* Optional: Save as preset */}
            {customMetricName.trim() && customPrompt.trim() && (
              <div className="flex items-center justify-between pt-2 border-t border-gray-200 dark:border-gray-700">
                <span className={`text-xs ${mutedClass}`}>
                  You can grade now, or save this metric for future use:
                </span>
                <button
                  onClick={async () => {
                    setSavingMetric(true);
                    try {
                      const success = await saveCustomMetric(
                        customMetricName.trim(),
                        `Custom metric: ${customMetricName}`,
                        gradeType,
                        customPrompt.trim()
                      );
                      if (success) {
                        // Switch to the newly saved metric
                        const key = customMetricName.toLowerCase().replace(/\s+/g, '_');
                        setSelectedMetric(key);
                        setCustomMetricName('');
                        setCustomPrompt('');
                      }
                    } finally {
                      setSavingMetric(false);
                    }
                  }}
                  disabled={savingMetric}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
                  title="Save this metric for future use"
                >
                  {savingMetric ? (
                    <span className="material-symbols-outlined animate-spin" style={{ fontSize: 14 }}>progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>bookmark_add</span>
                  )}
                  Save for Later
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Provider selection */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${textClass}`}>LLM Provider</label>
        <div className="flex gap-2">
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as LLMProvider)}
            className={`flex-1 px-3 py-2 rounded border text-sm ${inputClass}`}
          >
            {Object.entries(LLM_PROVIDERS).map(([key, config]) => (
              <option key={key} value={key}>{config.displayName}</option>
            ))}
          </select>
          <select
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
            className={`flex-1 px-3 py-2 rounded border text-sm ${inputClass}`}
          >
            {LLM_PROVIDERS[provider].models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Parallel Size */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${textClass}`}>Parallel Requests</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="1"
            max="500"
            value={parallelSize}
            onChange={(e) => setParallelSize(Math.max(1, Math.min(500, parseInt(e.target.value) || 100)))}
            className={`w-24 px-3 py-2 rounded border text-sm ${inputClass}`}
          />
          <span className={`text-xs ${mutedClass}`}>concurrent requests (1-500)</span>
        </div>
      </div>

      {/* Require Quotes */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="requireQuotes"
          checked={requireQuotes}
          onChange={(e) => setRequireQuotes(e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <label htmlFor="requireQuotes" className={`text-sm ${textClass}`}>
          Require quotes from transcript
        </label>
        <span className={`text-xs ${mutedClass}`}>(will retry if missing)</span>
      </div>

      {/* Advanced Settings */}
      <div className="space-y-2">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`flex items-center gap-1 text-sm font-medium ${textClass} hover:opacity-80`}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            {showAdvanced ? 'expand_less' : 'expand_more'}
          </span>
          Advanced Settings
        </button>
        
        {showAdvanced && (
          <div className={`space-y-3 p-3 rounded border ${isDarkMode ? 'border-gray-700 bg-gray-900/50' : 'border-gray-200 bg-gray-50'}`}>
            {/* Temperature */}
            <div className="space-y-1">
              <label className={`text-xs font-medium ${textClass}`}>
                Temperature
                <span className={`ml-1 ${mutedClass}`}>(default: model default)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature ?? ''}
                  onChange={(e) => setTemperature(e.target.value ? parseFloat(e.target.value) : undefined)}
                  placeholder="Model default"
                  className={`w-32 px-2 py-1 rounded border text-sm ${inputClass}`}
                />
                <span className={`text-xs ${mutedClass}`}>0.0 - 2.0</span>
                {temperature !== undefined && (
                  <button
                    onClick={() => setTemperature(undefined)}
                    className={`text-xs ${mutedClass} hover:opacity-80`}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Max Tokens */}
            <div className="space-y-1">
              <label className={`text-xs font-medium ${textClass}`}>
                Max Output Tokens
                <span className={`ml-1 ${mutedClass}`}>(default: model default)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  max="128000"
                  value={maxTokens ?? ''}
                  onChange={(e) => setMaxTokens(e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder="Model default"
                  className={`w-32 px-2 py-1 rounded border text-sm ${inputClass}`}
                />
                {maxTokens !== undefined && (
                  <button
                    onClick={() => setMaxTokens(undefined)}
                    className={`text-xs ${mutedClass} hover:opacity-80`}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Top P */}
            <div className="space-y-1">
              <label className={`text-xs font-medium ${textClass}`}>
                Top P
                <span className={`ml-1 ${mutedClass}`}>(default: model default)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={topP ?? ''}
                  onChange={(e) => setTopP(e.target.value ? parseFloat(e.target.value) : undefined)}
                  placeholder="Model default"
                  className={`w-32 px-2 py-1 rounded border text-sm ${inputClass}`}
                />
                <span className={`text-xs ${mutedClass}`}>0.0 - 1.0</span>
                {topP !== undefined && (
                  <button
                    onClick={() => setTopP(undefined)}
                    className={`text-xs ${mutedClass} hover:opacity-80`}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* API Key */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${textClass}`}>
          API Key
          {usingServerKey ? (
            <span className="ml-2 text-blue-500 text-xs">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>cloud_done</span>
              Using server .env
            </span>
          ) : hasApiKey ? (
            <span className="ml-2 text-green-500 text-xs">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check_circle</span>
              Saved locally
            </span>
          ) : null}
        </label>
        {usingServerKey ? (
          <p className={`text-xs ${mutedClass} p-2 rounded border ${isDarkMode ? 'border-blue-800 bg-blue-900/20' : 'border-blue-200 bg-blue-50'}`}>
            Using API key from server's <code className="px-1 rounded bg-gray-200 dark:bg-gray-700">.env</code> file. 
            You can override by entering a key below.
          </p>
        ) : null}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={hasApiKey ? '••••••••••••' : `Enter ${LLM_PROVIDERS[provider].displayName} API key...`}
              className={`w-full px-3 py-2 pr-10 rounded border text-sm ${inputClass}`}
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className={`absolute right-2 top-1/2 -translate-y-1/2 ${mutedClass}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                {showApiKey ? 'visibility_off' : 'visibility'}
              </span>
            </button>
          </div>
          <button
            onClick={handleSaveApiKey}
            disabled={!apiKeyInput.trim()}
            className={`px-3 py-2 rounded text-sm font-medium transition-colors
              ${apiKeyInput.trim() 
                ? 'bg-blue-500 text-white hover:bg-blue-600' 
                : 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-gray-700'
              }`}
          >
            Save
          </button>
        </div>
        {!usingServerKey && (
          <p className={`text-xs ${mutedClass}`}>
            API keys are stored locally in your browser.
          </p>
        )}
      </div>

      {/* Grade button and status */}
      <div className="pt-2 space-y-3">
        {/* Success message */}
        {progress.status === 'complete' && !progress.isRunning && (
          <div className="p-3 rounded-lg bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-green-600 dark:text-green-400" style={{ fontSize: 18 }}>check_circle</span>
              <span className="text-green-700 dark:text-green-300 text-sm">{progress.statusMessage}</span>
            </div>
          </div>
        )}

        {/* Cancelled message */}
        {progress.status === 'cancelled' && !progress.isRunning && (
          <div className="p-3 rounded-lg bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-yellow-600 dark:text-yellow-400" style={{ fontSize: 18 }}>cancel</span>
              <span className="text-yellow-700 dark:text-yellow-300 text-sm">{progress.statusMessage}</span>
            </div>
          </div>
        )}

        {progress.isRunning ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              {/* Spinner */}
              <svg className="animate-spin h-4 w-4 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className={textClass}>{progress.statusMessage}</span>
            </div>
            
            {/* Progress bar - only show during grading */}
            {progress.status === 'grading' && progress.total > 0 && (
              <div className="space-y-1">
                <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${(progress.completed / progress.total) * 100}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs">
                  <span className={mutedClass}>{progress.completed}/{progress.total} samples</span>
                  {progress.errors > 0 && (
                    <span className="text-red-500">{progress.errors} error{progress.errors !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
            )}

            {/* Cancel button */}
            <button
              onClick={cancelGrading}
              className="w-full px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 bg-red-500 text-white hover:bg-red-600"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={handleGrade}
            disabled={!hasApiKey || !currentMetric || filteredSampleIds.length === 0}
            className={`w-full px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2
              ${hasApiKey && currentMetric && filteredSampleIds.length > 0
                ? 'bg-blue-500 text-white hover:bg-blue-600' 
                : 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-gray-700'
              }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>psychology</span>
            Grade {filteredSampleIds.length} sample{filteredSampleIds.length !== 1 ? 's' : ''}
          </button>
        )}
      </div>

      {/* Info */}
      <p className={`text-xs ${mutedClass}`}>
        Grades will be saved to a viz/ subdirectory alongside the original file.
      </p>
    </div>
  );
}
