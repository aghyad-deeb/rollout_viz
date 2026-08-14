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

    // Max tokens / effort now live behind the Advanced Settings collapse
    fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
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


  it('surfaces pre-flight/connection failures next to the Grade button', () => {
    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading({
          error: 'Pre-flight check failed: 500 Internal Server Error',
          progress: {
            total: 3,
            completed: 0,
            errors: 0,
            errorDetails: [],
            isRunning: false,
            status: 'error',
            statusMessage: 'Grading failed',
            jobId: null,
          },
        } as Partial<ReturnType<typeof useGrading>>)}
      />,
    );

    // The red status block near the button renders even without per-sample
    // errorDetails, falling back to the hook-level error string.
    expect(screen.getByText('Grading failed')).toBeInTheDocument();
    const details = screen.getAllByText('Pre-flight check failed: 500 Internal Server Error');
    expect(details.some((el) => el.className.includes('font-mono'))).toBe(true);
  });


  it('disables Grade and shows a hint while a new custom metric is missing name or prompt', () => {
    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Helpfulness'), { target: { value: 'custom' } });

    const gradeButton = screen.getByRole('button', { name: /grade 1 sample/i });
    expect(gradeButton).toBeDisabled();
    expect(gradeButton).toHaveAttribute('title', 'Enter a metric name and prompt to grade');
    expect(screen.getByText('Enter a metric name and prompt to grade')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Metric name...'), { target: { value: 'My Metric' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your grading prompt...'), {
      target: { value: 'Grade it.' },
    });
    expect(screen.getByRole('button', { name: /grade 1 sample/i })).not.toBeDisabled();
  });


  it('sends trimmed custom metric name and prompt when grading', async () => {
    const gradeAndSave = vi.fn().mockResolvedValue({ graded_count: 1, errors: [], grades: {} });

    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading({ gradeAndSave })}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Helpfulness'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByPlaceholderText('Metric name...'), { target: { value: '  My Metric  ' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your grading prompt...'), {
      target: { value: '  Grade it.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /grade 1 sample/i }));

    await waitFor(() => expect(gradeAndSave).toHaveBeenCalledTimes(1));
    expect(gradeAndSave.mock.calls[0][2]).toBe('My Metric');
    expect(gradeAndSave.mock.calls[0][3]).toBe('Grade it.');
  });


  it('lets Max Output Tokens be cleared and retyped without snapping back', async () => {
    const gradeAndSave = vi.fn().mockResolvedValue({ graded_count: 1, errors: [], grades: {} });

    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading({ gradeAndSave })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
    const maxTokensInput = screen.getByLabelText('Max Output Tokens');

    // Clearing the field must not snap back to the default
    fireEvent.change(maxTokensInput, { target: { value: '' } });
    expect(maxTokensInput).toHaveValue(null);

    fireEvent.change(maxTokensInput, { target: { value: '8000' } });
    expect(maxTokensInput).toHaveValue(8000);

    fireEvent.click(screen.getByRole('button', { name: /grade 1 sample/i }));

    await waitFor(() => expect(gradeAndSave).toHaveBeenCalledTimes(1));
    expect(gradeAndSave.mock.calls[0][8]).toEqual(expect.objectContaining({ maxTokens: 8000 }));
    expect(typeof gradeAndSave.mock.calls[0][7]).toBe('number');
  });


  it('clamps number fields on blur and restores defaults when left empty', () => {
    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
    const maxTokensInput = screen.getByLabelText('Max Output Tokens');
    const parallelInput = screen.getByLabelText('Parallel Requests');

    fireEvent.change(maxTokensInput, { target: { value: '999999' } });
    fireEvent.blur(maxTokensInput);
    expect(maxTokensInput).toHaveValue(128000);

    fireEvent.change(maxTokensInput, { target: { value: '' } });
    fireEvent.blur(maxTokensInput);
    expect(maxTokensInput).toHaveValue(32768);

    fireEvent.change(parallelInput, { target: { value: '9999' } });
    fireEvent.blur(parallelInput);
    expect(parallelInput).toHaveValue(500);

    fireEvent.change(parallelInput, { target: { value: '' } });
    fireEvent.blur(parallelInput);
    expect(parallelInput).toHaveValue(100);
  });


  it('sends fallback values when number fields are cleared and never blurred', async () => {
    const gradeAndSave = vi.fn().mockResolvedValue({ graded_count: 1, errors: [], grades: {} });

    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading({ gradeAndSave })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
    fireEvent.change(screen.getByLabelText('Max Output Tokens'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Parallel Requests'), { target: { value: '' } });

    // Grade without ever blurring — must not send NaN
    fireEvent.click(screen.getByRole('button', { name: /grade 1 sample/i }));

    await waitFor(() => expect(gradeAndSave).toHaveBeenCalledTimes(1));
    expect(gradeAndSave.mock.calls[0][7]).toBe(100);
    expect(gradeAndSave.mock.calls[0][8]).toEqual(expect.objectContaining({ maxTokens: 32768 }));
  });


  it('hides parallel/max-token fields until Advanced Settings is expanded', () => {
    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading()}
      />,
    );

    expect(screen.queryByLabelText('Max Output Tokens')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Parallel Requests')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));

    expect(screen.getByLabelText('Max Output Tokens')).toBeInTheDocument();
    expect(screen.getByLabelText('Parallel Requests')).toBeInTheDocument();
    expect(screen.getByLabelText('Effort')).toBeInTheDocument();
  });


  it('collapses the API key row to a single line when using the server key', () => {
    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading()}
      />,
    );

    // One-line badge, no key input until Override is clicked
    expect(screen.getByText('Using server .env')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('••••••••••••')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Override' }));

    expect(screen.getByPlaceholderText('••••••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });


  it('shows the full API key input when no server key is available', () => {
    render(
      <GradingPanel
        gradingJobs={[{ filePath: 'samples.jsonl', sampleIds: [0] }]}
        isDarkMode={false}
        onGradingComplete={vi.fn()}
        grading={makeGrading({
          isUsingServerKey: vi.fn(() => false),
          hasApiKeyAvailable: vi.fn(() => false),
        })}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Override' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter openai api key/i)).toBeInTheDocument();
  });


  it('continues grading remaining files after one fails and shows a per-file summary', async () => {
    const gradeAndSave = vi.fn()
      .mockResolvedValueOnce(null) // first file fails (e.g. stream error)
      .mockResolvedValueOnce({ graded_count: 2, errors: [], grades: {} });
    const onGradingComplete = vi.fn();

    render(
      <GradingPanel
        gradingJobs={[
          { filePath: 'runs/run_a.jsonl', sampleIds: [0] },
          { filePath: 'runs/run_b.jsonl', sampleIds: [1, 2] },
        ]}
        isDarkMode={false}
        onGradingComplete={onGradingComplete}
        grading={makeGrading({ gradeAndSave })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /grade 3 samples/i }));

    // The second file still grades even though the first failed
    await waitFor(() => expect(gradeAndSave).toHaveBeenCalledTimes(2));
    expect(gradeAndSave.mock.calls[1][0]).toBe('runs/run_b.jsonl');
    await waitFor(() => expect(onGradingComplete).toHaveBeenCalledTimes(1));

    // Mixed-outcome summary line near the status area
    expect(
      await screen.findByText('run_a.jsonl: failed · run_b.jsonl: 2 graded')
    ).toBeInTheDocument();
  });

});
