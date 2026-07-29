import { describe, it, expect } from 'vitest';
import { cassetteFetch, cassetteKey } from './fetch.ts';
import { InMemoryCassetteStore } from './store.ts';

describe('cassetteFetch in replay mode', () => {
  it('throws naming the missing key rather than calling through', async () => {
    const store = new InMemoryCassetteStore();
    let called = false;
    const live: typeof fetch = async () => { called = true; return new Response('{}'); };

    const f = cassetteFetch('replay', store, live);

    await expect(f('https://example.test/x')).rejects.toThrow(/cassette miss/i);
    expect(called).toBe(false);
  });

  it('replays a stored response without calling through', async () => {
    const store = new InMemoryCassetteStore();
    await store.put('GET https://example.test/x', {
      status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}',
    });
    let called = false;
    const live: typeof fetch = async () => { called = true; return new Response('{}'); };

    const res = await cassetteFetch('replay', store, live)('https://example.test/x');

    expect(await res.json()).toEqual({ ok: true });
    expect(called).toBe(false);
  });
});

describe('cassetteFetch in record mode', () => {
  it('records and returns the live response', async () => {
    const store = new InMemoryCassetteStore();
    const live: typeof fetch = async () => new Response('{"v":1}', { status: 200 });

    const res = await cassetteFetch('record', store, live)('https://example.test/y');

    expect(await res.json()).toEqual({ v: 1 });
    expect(await store.get('GET https://example.test/y')).not.toBeNull();
  });

  it('returns a body that is still readable after recording', async () => {
    // Recording must not consume the stream the caller is about to read.
    const store = new InMemoryCassetteStore();
    const live: typeof fetch = async () => new Response('{"v":2}');
    const res = await cassetteFetch('record', store, live)('https://example.test/z');
    expect(await res.text()).toBe('{"v":2}');
  });
});

describe('cassetteFetch in live mode', () => {
  it('calls through and records nothing', async () => {
    const store = new InMemoryCassetteStore();
    const live: typeof fetch = async () => new Response('{"v":3}');
    await cassetteFetch('live', store, live)('https://example.test/w');
    expect(await store.get('GET https://example.test/w')).toBeNull();
  });
});

describe('cassetteKey', () => {
  it('distinguishes POSTs with different bodies', () => {
    const a = cassetteKey('POST', 'https://x.test/', '{"a":1}');
    const b = cassetteKey('POST', 'https://x.test/', '{"a":2}');
    expect(a).not.toBe(b);
  });

  it('is stable for the same request', () => {
    expect(cassetteKey('POST', 'https://x.test/', '{"a":1}'))
      .toBe(cassetteKey('POST', 'https://x.test/', '{"a":1}'));
  });
});
