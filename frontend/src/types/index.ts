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

export interface Sample {
  id: number;
  messages: Message[];
  attributes: SampleAttributes;
  timestamp: string;
}

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
