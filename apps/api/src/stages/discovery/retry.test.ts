import { describe, it, expect } from 'vitest';
import { fetchWithRetry } from './retry.ts';

const noWait = async (): Promise<void> => {};

describe('fetchWithRetry', () => {
  it('retries on 502 and succeeds on the third attempt', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) return new Response('bad gateway', { status: 502 });
      return new Response('{"ok":true}', { status: 200 });
    };

    const res = await fetchWithRetry(fake, 'https://example.test/', undefined, {
      wait: noWait,
    });

    expect(calls).toBe(3);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not retry a 404 and fails after a single call', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls += 1;
      return new Response('not found', { status: 404 });
    };

    await expect(
      fetchWithRetry(fake, 'https://example.test/', undefined, { wait: noWait }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it('retries on a thrown network error and succeeds', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls += 1;
      if (calls < 2) throw new Error('ECONNRESET');
      return new Response('{}', { status: 200 });
    };

    const res = await fetchWithRetry(fake, 'https://example.test/', undefined, {
      wait: noWait,
    });

    expect(calls).toBe(2);
    expect(res.status).toBe(200);
  });

  it('gives up after exhausting retries on persistent 5xx', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls += 1;
      return new Response('boom', { status: 503 });
    };

    await expect(
      fetchWithRetry(fake, 'https://example.test/', undefined, { wait: noWait, retries: 3 }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(3);
  });
});
