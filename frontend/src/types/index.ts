export interface ToolCall {
  type: string;
  id?: string | null;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ContentPart {
  type: 'thinking' | 'text' | string;
  thinking?: string;
  text?: string;
  channel?: string;
  [key: string]: unknown;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'file';
  content: string;
  reasoning?: string;
  content_parts?: ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  raw_content?: string;
  tokens?: number[];
  prompt_tokens?: number[];
  openai_response_items?: unknown[];
  [key: string]: unknown;
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
  /**
   * Which channel of the message this quote is drawn from. Auto_eval's
   * multi-channel renderer decomposes a single message into separate
   * streams for thinking, visible text, tool-call intent, tool-result
   * output, and (rl_late) reasoning summaries; the channel attribute
   * specifies which one this quote came from.
   *
   * Optional for backward compat with grades produced before
   * multi-channel rendering. Consumers should treat `undefined` as
   * `'text'` (the only channel pre-multi-channel forks could see).
   *
   * Highlight rendering today is text-substring-based and ignores
   * `start`/`end`, so this field is purely advisory for now — but
   * future channel-aware rendering (e.g. rendering thinking blocks
   * collapsed) will use it to pick the correct sub-region.
   */
  channel?: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'reasoning_summary';
  start: number;
  end: number;
  text: string;
}

export type GradeType = 'float' | 'int' | 'bool' | 'freeform';

export interface GradeEntry {
  // `string` is populated when grade_type === 'freeform' — the LLM's prose
  // answer goes directly into `grade`. Numeric/bool grades keep their types.
  grade: number | boolean | string;
  grade_type: GradeType;
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
  message_count?: number;
  attributes: SampleAttributes;
  timestamp: string;
  grades?: SampleGrades;
  raw_messages?: unknown[];
  raw_jsonl_entry?: unknown;
  [key: string]: unknown;
}

// Grading request/response types
export interface GradeRequest {
  file_path: string;
  sample_ids: number[];
  metric_name: string;
  metric_prompt: string;
  grade_type: GradeType;
  provider: LLMProvider;
  model: string;
  router_provider?: 'litellm' | 'rl_late' | 'tinker';
  max_attempts?: number;
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
  grade_type: GradeType;
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

// Ephemeral, session-only highlight created by the user selecting text and
// clicking "Highlight" in the selection popup. Cleared automatically when the
// user navigates to a different sample. Never persisted (no URL, no storage,
// no backend).
// Pins a collapse / highlight to one specific occurrence of its text, so the
// same string appearing elsewhere in the message isn't affected too.
// `blockKind` identifies the renderable block; `occurrence` is the match
// index within that block. A region/highlight with no locator matches its
// text everywhere (used for whole-section collapses, whose text is unique).
export interface RegionLocator {
  blockKind: 'reasoning' | 'content' | 'tool';
  blockIndex?: number;  // tool-call index when blockKind === 'tool'
  occurrence: number;
}

export interface EphemeralHighlight {
  id: string;
  messageIndex: number;
  text: string;
  /**
   * Visual treatment of the span. 'highlight' (the default) is the fuchsia
   * marker; 'bold' / 'italic' apply font emphasis instead. All three are
   * session-only and removed by clicking the styled span.
   */
  style?: 'highlight' | 'bold' | 'italic';
  /** Pins the highlight to one occurrence of `text` (see RegionLocator). */
  locator?: RegionLocator;
}

// A span of message text the user has collapsed in Presentation Mode. The
// span renders as an editable `[...]` elision pill instead of the text.
// Session-only — same lifecycle as EphemeralHighlight (cleared on sample
// change, never persisted). `label` is the user-edited elision text;
// undefined means show the default (`[...]` or `[N lines]`).
export interface CollapsedRegion {
  id: string;
  messageIndex: number;
  text: string;
  label?: string;
  /** Hidden regions stay collapsed but render nothing (no `[...]` marker). */
  hidden?: boolean;
  /**
   * Explicit line-placement overrides for the pill, each tri-state:
   * undefined keeps the source text's own line breaks (the natural
   * default); true pulls the pill onto the same line as the adjacent text;
   * false forces a line break so the pill sits on its own line. Toggled
   * from the pill's right-click menu.
   */
  joinBefore?: boolean;
  joinAfter?: boolean;
  /** Pins the collapse to one occurrence of `text` (see RegionLocator). */
  locator?: RegionLocator;
}

// Export-width presets for Presentation Mode image capture. Controls the
// off-screen render width so text reflows (not scales) to the target.
// Ordered narrow → wide; label + pixel width live in EXPORT_WIDTH_PRESETS
// (utils/captureImage.ts).
export type ExportWidth = 'narrow' | 'paper2' | 'paper1' | 'half' | 'slide' | 'slidewide';

// Capture font-size presets. The multiplier (`scale`) + label live in
// FONT_SIZE_PRESETS (utils/captureImage.ts).
export type FontSize = 'sm' | 'md' | 'lg' | 'xl';
