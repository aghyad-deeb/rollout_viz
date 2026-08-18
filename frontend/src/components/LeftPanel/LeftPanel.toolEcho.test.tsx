/**
 * The table's global search must see exactly what the transcript renders.
 *
 * Tool results often echo the executed command as their first line, and the
 * chat view strips that echo (utils/toolEcho.ts) because the assistant's CALL
 * band already shows it. Before round 1 of the figure critic loop, LeftPanel
 * searched and counted the RAW messages: a term that lived only inside an
 * echoed command made the sample "match" with a hit count the transcript had
 * no mark to jump to. Both now go through `displayMessages`.
 */
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LeftPanel } from './index';
import { makeSample, makeAttributes } from '../../test/fixtures';
import type { Message, Sample } from '../../types';

const generateId = () => Math.random().toString(36).substring(2, 9);

function bashCall(command: string): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ type: 'function', function: { name: 'bash', arguments: { command } } }],
  };
}

/** A rollout whose ONLY occurrence of `needle` is the echoed command. */
function echoOnlySample(id: number, needle: string): Sample {
  const command = `grep -rn ${needle} /srv`;
  return makeSample({
    id,
    attributes: { ...makeAttributes(), sample_index: id, rollout_n: id },
    messages: [
      { role: 'user', content: 'find it' },
      bashCall(command),
      { role: 'tool', content: `${command}\nno matches found` },
    ],
  });
}

/** A rollout that genuinely mentions `needle` in visible output. */
function realHitSample(id: number, needle: string): Sample {
  return makeSample({
    id,
    attributes: { ...makeAttributes(), sample_index: id, rollout_n: id },
    messages: [
      { role: 'user', content: 'find it' },
      bashCall('grep -rn thing /srv'),
      { role: 'tool', content: `grep -rn thing /srv\nfound ${needle} twice: ${needle}` },
    ],
  });
}

function makeProps(overrides: Partial<Parameters<typeof LeftPanel>[0]> = {}) {
  return {
    samples: [] as Sample[],
    selectedSampleId: null,
    onSelectSample: vi.fn(),
    experimentName: 'echo_test',
    filePaths: ['echo_test.jsonl'],
    onFilePathsChange: vi.fn(),
    onOpenFileBrowser: vi.fn(),
    searchConditions: [{ id: generateId(), field: 'chat' as const, operator: 'contains' as const, term: '' }],
    onSearchConditionsChange: vi.fn(),
    searchLogic: 'AND' as const,
    onSearchLogicChange: vi.fn(),
    loading: false,
    error: null,
    isDarkMode: false,
    onToggleDarkMode: vi.fn(),
    onFilteredSamplesChange: vi.fn(),
    onCurrentOccurrenceIndexChange: vi.fn(),
    ...overrides,
  };
}

const filteredIds = (onFiltered: ReturnType<typeof vi.fn>): number[] =>
  ((onFiltered.mock.calls.at(-1)?.[0] ?? []) as Sample[]).map((s) => s.id);

describe('LeftPanel global search vs the stripped tool echo', () => {
  it('does not match a sample whose only hit is inside the echoed command', () => {
    const onFiltered = vi.fn();
    const samples = [echoOnlySample(0, 'zebrafish'), realHitSample(1, 'zebrafish')];

    render(
      <LeftPanel
        {...makeProps({
          samples,
          onFilteredSamplesChange: onFiltered,
          searchConditions: [{ id: 'c1', field: 'chat', operator: 'contains', term: 'zebrafish' }],
        })}
      />,
    );

    // Only the rollout that really shows the term survives the filter.
    expect(filteredIds(onFiltered)).toEqual([1]);
  });

  it('counts only the occurrences the transcript can scroll to', () => {
    const onFiltered = vi.fn();
    // 2 hits in visible output, 1 in the rendered CALL band; the echoed copy
    // of the command is the only thing the transcript does NOT draw.
    const sample = makeSample({
      id: 0,
      attributes: { ...makeAttributes(), sample_index: 0, rollout_n: 0 },
      messages: [
        { role: 'user', content: 'go' },
        bashCall('grep -rn zebrafish /srv'),
        { role: 'tool', content: 'grep -rn zebrafish /srv\nhit zebrafish here\nand zebrafish there' },
      ],
    });

    const { container } = render(
      <LeftPanel
        {...makeProps({
          samples: [sample],
          selectedSampleId: 0,
          onFilteredSamplesChange: onFiltered,
          searchConditions: [{ id: 'c1', field: 'chat', operator: 'contains', term: 'zebrafish' }],
        })}
      />,
    );

    // The readout reports "<n>/<total> in chat …" once a sample has >1 hit.
    // Three marks exist in the transcript: the CALL band (which legitimately
    // shows the command) plus the two in the visible output. Counting the raw
    // messages added a fourth for the echo — a phantom the user cannot reach.
    expect(container.textContent).toContain('1/3 in chat');
    expect(container.textContent).not.toContain('1/4 in chat');
  });

  it('leaves a search that targets the tool field alone when the echo is not the hit', () => {
    const onFiltered = vi.fn();
    render(
      <LeftPanel
        {...makeProps({
          samples: [realHitSample(0, 'zebrafish')],
          onFilteredSamplesChange: onFiltered,
          searchConditions: [{ id: 'c1', field: 'tool', operator: 'contains', term: 'zebrafish' }],
        })}
      />,
    );

    expect(filteredIds(onFiltered)).toEqual([0]);
  });
});
