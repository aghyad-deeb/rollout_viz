export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string;
}

export interface SampleAttributes {
  step: number;
  sample_index: number;
  rollout_n: number;
  reward: number;
  data_source: string;
  experiment_name: string;
  is_validate: boolean;
  source_file?: string; // Which file this sample came from (for multi-file loading)
}

// Grading types
export interface Quote {
  message_index: number;
  start: number;
  end: number;
  text: string;
}

export interface GradeEntry {
  grade: number | boolean;
  grade_type: 'float' | 'int' | 'bool';
  quotes: Quote[];
  explanation: string;
  model: string;
  prompt_version: string;
  timestamp: string;
}

export interface SampleGrades {
  [metricName: string]: GradeEntry[];
}

export interface Sample {
  id: number;
  messages: Message[];
  attributes: SampleAttributes;
  timestamp: string;
  grades?: SampleGrades;
}

// Grading request/response types
export interface GradeRequest {
  file_path: string;
  sample_ids: number[];
  metric_name: string;
  metric_prompt: string;
  grade_type: 'float' | 'int' | 'bool';
  provider: LLMProvider;
  model: string;
  api_key?: string;  // Optional - server will use .env if not provided
  parallel_size?: number;  // Number of concurrent requests (default: 100)
  require_quotes?: boolean;  // Whether to require quotes from the model (default: true)
  max_quote_retries?: number;  // Max retries if quotes missing (default: 2)
  // Advanced settings
  temperature?: number;  // 0.0 - 2.0, undefined = model default
  max_tokens?: number;  // Max output tokens
  top_p?: number;  // 0.0 - 1.0
}

export interface GradeResponse {
  graded_count: number;
  errors: { sample_id: number; error: string }[];
  grades: { [sampleId: number]: GradeEntry };
}

export interface PresetMetric {
  name: string;
  description: string;
  grade_type: 'float' | 'int' | 'bool';
  is_custom?: boolean;  // True if user-created
  prompt: string;
}

export type LLMProvider = 'openai' | 'anthropic' | 'google' | 'openrouter';

export interface LLMProviderConfig {
  name: string;
  displayName: string;
  defaultModel: string;
  models: string[];
}

export const LLM_PROVIDERS: Record<LLMProvider, LLMProviderConfig> = {
  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o',
    models: [
      // GPT-5.2 series (latest)
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.2-pro',
      // GPT-5.1 series
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-mini',
      'gpt-5.1-codex-max',
      // GPT-5 series
      'gpt-5',
      'gpt-5-codex',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-pro',
      // GPT-4 series
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4-turbo',
      // Reasoning models
      'o1',
      'o1-pro',
      'o3',
      'o3-mini',
      'o3-pro',
    ],
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    models: [
      'claude-opus-4-5-20251101',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-20241022',
    ],
  },
  google: {
    name: 'google',
    displayName: 'Google',
    defaultModel: 'gemini-2.5-flash',
    models: [
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
    ],
  },
  openrouter: {
    name: 'openrouter',
    displayName: 'OpenRouter',
    defaultModel: 'openai/gpt-4o',
    models: [
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/o3',
      'openai/o3-mini',
      'anthropic/claude-opus-4.5',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-3.7-sonnet',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.1-405b-instruct',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat',
      'mistralai/devstral-2512',
    ],
  },
};

export interface FileInfo {
  key: string;
  size: number;
  last_modified: string;
}

// SortColumn can be a standard column or a metric column (prefixed with 'grade:')
export type SortColumn = 'sample_index' | 'step' | 'data_source' | 'reward' | 'num_messages' | string;
export type SortOrder = 'asc' | 'desc';
export type SearchField = 
  | 'chat' 
  | 'all' 
  | 'system' 
  | 'user' 
  | 'assistant' 
  | 'tool' 
  | 'reasoning'
  | 'data_source' 
  | 'reward' 
  | 'step' 
  | 'timestamp' 
  | 'experiment_name';

export type ViewMode = 'eval' | 'meta' | 'chat' | 'analysis';

export type SearchOperator = 'contains' | 'not_contains';

export interface SearchCondition {
  id: string;
  field: SearchField;
  operator: SearchOperator;
  term: string;
}

export type SearchLogic = 'AND' | 'OR';
