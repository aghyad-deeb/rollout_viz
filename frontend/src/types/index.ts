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
    defaultModel: 'gpt-4o',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'o1',
      'o1-mini',
      'o1-preview',
      'o3-mini',
    ],
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    models: [
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-20241022',
      'claude-3-5-sonnet-20241022',
    ],
  },
  google: {
    name: 'google',
    displayName: 'Google',
    defaultModel: 'gemini-2.5-flash',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
  },
  openrouter: {
    name: 'openrouter',
    displayName: 'OpenRouter',
    defaultModel: 'openai/gpt-4o',
    models: [
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/o1',
      'openai/o3-mini',
      'anthropic/claude-sonnet-4',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat',
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
