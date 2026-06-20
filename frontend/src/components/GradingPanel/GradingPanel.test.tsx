import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GradingPanel } from './index';
import type { useGrading } from '../../hooks/useGrading';

function makeGrading(overrides: Partial<ReturnType<typeof useGrading>> = {}): ReturnType<typeof useGrading> {
  return {
    progress: {
      total: 0,
      completed: 0,
      errors: 0,
      errorDetails: [],
      isRunning: false,
      status: 'idle',
      statusMessage: '',
    },
    error: null,
    presetMetrics: {
      helpfulness: {
        name: 'Helpfulness',
        description: 'Helpful response.',
        grade_type: 'float',
        prompt: 'Grade helpfulness.',
      },
    },
    lastProvider: 'openai',
    lastModel: 'gpt-5.5',
    apiKeys: {},
    serverApiKeys: { openai: true },
    gradeSamples: vi.fn(),
    gradeAndSave: vi.fn(),
    cancelGrading: vi.fn(),
    saveApiKey: vi.fn(),
    getApiKey: vi.fn(() => ''),
    hasApiKeyAvailable: vi.fn(() => true),
    isUsingServerKey: vi.fn(() => true),
    saveLastProvider: vi.fn(),
    saveLastModel: vi.fn(),
    saveCustomMetric: vi.fn(),
    deleteCustomMetric: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useGrading>;
}

describe('GradingPanel', () => {
  it('requires quotes by default', () => {
    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading()}
      />,
    );

    expect(screen.getByLabelText('Require quotes from transcript')).toBeChecked();
  });


  it('sends the visible max token budget and effort setting', async () => {
    const gradeAndSave = vi.fn().mockResolvedValue({
      graded_count: 1,
      errors: [],
      grades: {},
    });
    const onGradingComplete = vi.fn();

    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={onGradingComplete}
        grading={makeGrading({ gradeAndSave })}
      />,
    );

    expect(screen.getByLabelText('Max Output Tokens')).toHaveValue(32768);
    expect(screen.getByLabelText('Effort')).toHaveValue('low');

    fireEvent.click(screen.getByRole('button', { name: /grade 1 sample/i }));

    await waitFor(() => expect(gradeAndSave).toHaveBeenCalledTimes(1));
    expect(gradeAndSave.mock.calls[0][8]).toEqual(expect.objectContaining({
      maxTokens: 32768,
      reasoningEffort: 'low',
    }));
    expect(onGradingComplete).toHaveBeenCalledTimes(1);
  });


  it('edits and saves an existing custom metric using its original key', async () => {
    const saveCustomMetric = vi.fn().mockResolvedValue(true);

    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading({
          saveCustomMetric,
          presetMetrics: {
            helpfulness: {
              name: 'Helpfulness',
              description: 'Helpful response.',
              grade_type: 'float',
              prompt: 'Grade helpfulness.',
            },
            my_metric: {
              name: 'My Metric',
              description: 'Custom metric: My Metric',
              grade_type: 'bool',
              prompt: 'Old prompt',
              is_custom: true,
            },
          },
        })}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Helpfulness'), { target: { value: 'my_metric' } });
    fireEvent.click(screen.getByTitle('Edit custom metric'));

    expect(screen.getByDisplayValue('My Metric')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Old prompt')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Enter your grading prompt...'), {
      target: { value: 'New prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(saveCustomMetric).toHaveBeenCalledWith(
      'My Metric',
      'Custom metric: My Metric',
      'bool',
      'New prompt',
      'my_metric',
    ));
  });

});
