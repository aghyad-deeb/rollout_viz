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
  api_key: string;
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
    defaultModel: 'gpt-5.2',
    models: [
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-4o',
      'gpt-4o-mini',
    ],
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    models: [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
    ],
  },
  google: {
    name: 'google',
    displayName: 'Google',
    defaultModel: 'gemini-2.5-pro',
    models: [
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
  },
  openrouter: {
    name: 'openrouter',
    displayName: 'OpenRouter',
    defaultModel: 'openai/gpt-5.2',
    models: [
      'openai/gpt-5.2',
      'openai/gpt-5.2-codex',
      'anthropic/claude-opus-4.5',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.3-70b',
      'mistralai/devstral-2',
    ],
  },
};

export interface FileInfo {
  key: string;
  size: number;
  last_modified: string;
}

export type SortColumn = 'sample_index' | 'step' | 'data_source' | 'reward' | 'num_messages';
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
