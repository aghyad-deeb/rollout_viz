import { buildPublicUrl, safeSameOriginRolloutUrl } from './config';

describe('config URL helpers', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        origin: 'http://localhost:3000',
      },
    });
  });

  it('builds public URLs from the current origin', () => {
    const params = new URLSearchParams({ file: 'trace.jsonl', rollout: '3' });
    expect(buildPublicUrl(params)).toBe('http://localhost:3000/?file=trace.jsonl&rollout=3');
  });

  it('accepts same-origin rollout metadata URLs', () => {
    const url = safeSameOriginRolloutUrl('http://localhost:3000/?file=trace.jsonl&message=1');
    expect(url).toBe('http://localhost:3000/?file=trace.jsonl&message=1');
  });

  it('rejects cross-origin rollout metadata URLs', () => {
    const url = safeSameOriginRolloutUrl('https://attacker.example/?file=trace.jsonl');
    expect(url).toBeNull();
  });

  it('rejects metadata URLs outside the rollout route shape', () => {
    expect(safeSameOriginRolloutUrl('http://localhost:3000/admin?file=trace.jsonl')).toBeNull();
    expect(safeSameOriginRolloutUrl('http://localhost:3000/?next=https://attacker.example')).toBeNull();
  });
});
