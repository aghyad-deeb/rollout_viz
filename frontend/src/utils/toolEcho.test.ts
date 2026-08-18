import { describe, it, expect } from 'vitest';
import { stripToolEcho, callingAssistantFor, displayMessages } from './toolEcho';
import type { Message } from '../types';

const call = (command: string): Message => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ type: 'function', function: { name: 'bash', arguments: { command } } }],
});

describe('stripToolEcho', () => {
  it('strips an echoed single-line command plus its newline', () => {
    const out = stripToolEcho('ls -la\ntotal 4\nfile.txt', call('ls -la'));
    expect(out).toEqual({ text: 'total 4\nfile.txt', stripped: true });
  });

  it('strips a multi-line heredoc echo', () => {
    const cmd = "cat > x.py << 'EOF'\nprint(1)\nEOF";
    const out = stripToolEcho(`${cmd}\nwrote x.py`, call(cmd));
    expect(out).toEqual({ text: 'wrote x.py', stripped: true });
  });

  it('handles string-typed arguments', () => {
    const asst: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ type: 'function', function: { name: 'bash', arguments: 'echo hi' } }],
    };
    expect(stripToolEcho('echo hi\nhi', asst)).toEqual({ text: 'hi', stripped: true });
  });

  it('empties a result that is ONLY the echoed command', () => {
    expect(stripToolEcho('ls -la', call('ls -la'))).toEqual({ text: '', stripped: true });
    expect(stripToolEcho('ls -la\n', call('ls -la'))).toEqual({ text: '', stripped: true });
  });

  it('does not strip when the output merely begins with similar text', () => {
    // "ls -lash" begins with "ls -la" but not at a line boundary.
    const out = stripToolEcho('ls -lash output', call('ls -la'));
    expect(out.stripped).toBe(false);
    expect(out.text).toBe('ls -lash output');
  });

  it('leaves non-echoing output untouched', () => {
    const out = stripToolEcho('total 4\nfile.txt', call('ls -la'));
    expect(out).toEqual({ text: 'total 4\nfile.txt', stripped: false });
  });

  it('checks every call of a parallel-call assistant', () => {
    const asst: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { type: 'function', function: { name: 'bash', arguments: { command: 'pwd' } } },
        { type: 'function', function: { name: 'bash', arguments: { command: 'whoami' } } },
      ],
    };
    expect(stripToolEcho('whoami\nroot', asst)).toEqual({ text: 'root', stripped: true });
  });

  it('is inert without a calling assistant or without commands', () => {
    expect(stripToolEcho('ls\nout', undefined)).toEqual({ text: 'ls\nout', stripped: false });
    expect(stripToolEcho('ls\nout', { role: 'assistant', content: 'no calls' })).toEqual({
      text: 'ls\nout',
      stripped: false,
    });
  });
});

describe('callingAssistantFor', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'go' },
    call('ls'),
    { role: 'tool', content: 'a' },
    { role: 'tool', content: 'b' },
    { role: 'assistant', content: 'done' },
    { role: 'tool', content: 'orphan after plain assistant' },
  ];

  it('finds the caller for the first result', () => {
    expect(callingAssistantFor(msgs, 2)).toBe(msgs[1]);
  });

  it('scans back past sibling tool results (parallel calls)', () => {
    expect(callingAssistantFor(msgs, 3)).toBe(msgs[1]);
  });

  it('returns undefined when the nearest assistant made no calls', () => {
    expect(callingAssistantFor(msgs, 5)).toBeUndefined();
  });

  it('returns undefined when a non-tool, non-assistant message intervenes', () => {
    const withUser: Message[] = [call('ls'), { role: 'user', content: 'x' }, { role: 'tool', content: 'y' }];
    expect(callingAssistantFor(withUser, 2)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// displayMessages — THE shared display mapping
//
// ChatView renders these messages and LeftPanel searches/counts them. They ran
// on different arrays before (raw vs stripped), so the table could report a
// match the transcript had no mark for.
// ---------------------------------------------------------------------------

describe('displayMessages', () => {
  it('strips the echo on every tool result, leaving other roles alone', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'go' },
      call('grep -rn secret /etc'),
      { role: 'tool', content: 'grep -rn secret /etc\n/etc/passwd: nothing' },
    ];
    const out = displayMessages(msgs);
    expect(out).not.toBe(msgs);
    expect(out[2].content).toBe('/etc/passwd: nothing');
    expect(out[2].raw_content).toBe('grep -rn secret /etc\n/etc/passwd: nothing');
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });

  it('returns the ORIGINAL array when nothing strips (allocation-light contract)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'go' },
      call('ls'),
      { role: 'tool', content: 'file.txt' },
    ];
    expect(displayMessages(msgs)).toBe(msgs);
  });

  it('caches per source array, so repeated search passes do not recompute', () => {
    const msgs: Message[] = [call('ls -la'), { role: 'tool', content: 'ls -la\ntotal 0' }];
    const first = displayMessages(msgs);
    expect(displayMessages(msgs)).toBe(first);
  });

  it('hides text that lived ONLY in the echoed command', () => {
    const msgs: Message[] = [
      call('rg --hidden needle_in_command'),
      { role: 'tool', content: 'rg --hidden needle_in_command\nno matches' },
    ];
    const text = displayMessages(msgs).map((m) => m.content).join('\n');
    expect(text).not.toContain('needle_in_command');
  });
});
