import type { Sample, Message, SampleAttributes } from '../types';

// Type for grade entries
interface GradeEntry {
  grade: number | boolean;
  grade_type: 'float' | 'int' | 'bool';
  quotes: Array<{ message_index: number; start: number; end: number; text: string }>;
  explanation: string;
  model: string;
  timestamp: string;
}

export function makeMessage(role: string = 'user', content: string = 'Hello'): Message {
  return { role: role as Message['role'], content };
}

export function makeAttributes(overrides: Partial<SampleAttributes> = {}): SampleAttributes {
  return {
    step: 0,
    sample_index: 0,
    rollout_n: 0,
    reward: 0.0,
    data_source: 'test/source',
    experiment_name: 'test_exp',
    is_validate: false,
    ...overrides,
  };
}

export function makeSample(overrides: Partial<Sample> & { id?: number } = {}): Sample {
  const { attributes: attrOverrides, ...rest } = overrides;
  return {
    id: 0,
    messages: [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi there!')],
    timestamp: '2026-01-15T10:00:00',
    ...rest,
    attributes: { ...makeAttributes(), ...(attrOverrides || {}) },
  };
}

export function makeGradeEntry(
  grade: number | boolean = true,
  type: 'float' | 'int' | 'bool' = 'bool',
  quotes: GradeEntry['quotes'] = [],
): GradeEntry {
  return {
    grade,
    grade_type: type,
    quotes,
    explanation: 'Test explanation',
    model: 'test-model',
    timestamp: '2026-01-15T10:00:00',
  };
}

export function makeSamplesResponse(count: number = 5, overrides: Partial<Sample> = {}) {
  return {
    samples: Array.from({ length: count }, (_, i) =>
      makeSample({ id: i, attributes: { ...makeAttributes(), sample_index: i, rollout_n: i }, ...overrides })
    ),
    total: count,
    experiment_name: 'test_experiment',
    file_path: 'test.jsonl',
    has_grades: false,
  };
}
