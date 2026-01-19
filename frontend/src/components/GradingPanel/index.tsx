import { useState, useMemo } from 'react';
import type { LLMProvider } from '../../types';
import { LLM_PROVIDERS } from '../../types';
import { useGrading } from '../../hooks/useGrading';

interface GradingPanelProps {
  filteredSampleIds: number[];
  filePath: string;
  isDarkMode: boolean;
  onGradingComplete: () => void; // Callback to refresh samples after grading
}

export function GradingPanel({
  filteredSampleIds,
  filePath,
  isDarkMode,
  onGradingComplete,
}: GradingPanelProps) {
  const {
    progress,
    error,
    presetMetrics,
    lastProvider,
    lastModel,
    gradeAndSave,
    saveApiKey,
    getApiKey,
    saveLastProvider,
    saveLastModel,
    clearError,
  } = useGrading();

  // Form state
  const [selectedMetric, setSelectedMetric] = useState<string>('helpfulness');
  const [customMetricName, setCustomMetricName] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [gradeType, setGradeType] = useState<'float' | 'int' | 'bool'>('float');
  const [provider, setProvider] = useState<LLMProvider>(lastProvider);
  const [model, setModel] = useState<string>(lastModel);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  // Check if we have a valid API key
  const hasApiKey = useMemo(() => {
    return !!getApiKey(provider);
  }, [getApiKey, provider]);

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

    const result = await gradeAndSave(
      filePath,
      filteredSampleIds,
      selectedMetric === 'custom' ? customMetricName : selectedMetric,
      currentMetric.prompt,
      currentMetric.grade_type as 'float' | 'int' | 'bool',
      provider,
      model,
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
        <select
          value={selectedMetric}
          onChange={(e) => setSelectedMetric(e.target.value)}
          className={`w-full px-3 py-2 rounded border text-sm ${inputClass}`}
        >
          {Object.entries(presetMetrics).map(([key, metric]) => (
            <option key={key} value={key}>{metric.name}</option>
          ))}
          <option value="custom">Custom...</option>
        </select>

        {/* Preset metric description */}
        {selectedMetric !== 'custom' && presetMetrics[selectedMetric] && (
          <p className={`text-xs ${mutedClass}`}>
            {presetMetrics[selectedMetric].description}
            <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
              {presetMetrics[selectedMetric].grade_type}
            </span>
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
            <div className="flex gap-2">
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

      {/* API Key */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${textClass}`}>
          API Key
          {hasApiKey && (
            <span className="ml-2 text-green-500 text-xs">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check_circle</span>
              Saved
            </span>
          )}
        </label>
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
        <p className={`text-xs ${mutedClass}`}>
          API keys are stored locally in your browser.
        </p>
      </div>

      {/* Grade button */}
      <div className="pt-2">
        {progress.isRunning ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className={textClass}>
                Grading... {progress.completed}/{progress.total}
              </span>
              {progress.errors > 0 && (
                <span className="text-red-500">{progress.errors} errors</span>
              )}
            </div>
            <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${(progress.completed / progress.total) * 100}%` }}
              />
            </div>
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
