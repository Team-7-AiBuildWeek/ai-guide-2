import { describe, it, expect } from 'vitest';
import { fetchExtracts } from './wikipedia.ts';

function fakeResponse(titles: string[]): Response {
  const pages = titles.map((title) => ({ title, extract: `Extract for ${title}.` }));
  return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
}

describe('fetchExtracts', () => {
  it('batches at most 20 titles per request', async () => {
    const titles = Array.from({ length: 45 }, (_, i) => `Title ${i}`);
    const requestedBatches: string[][] = [];

    const fake: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL).href);
      const batch = (url.searchParams.get('titles') ?? '').split('|');
      requestedBatches.push(batch);
      return fakeResponse(batch);
    };

    const result = await fetchExtracts(titles, 'en', { fetch: fake });

    expect(requestedBatches).toHaveLength(3); // 20 + 20 + 5
    expect(requestedBatches[0]).toHaveLength(20);
    expect(requestedBatches[2]).toHaveLength(5);
    expect(result.get('Title 0')).toBe('Extract for Title 0.');
    expect(result.get('Title 44')).toBe('Extract for Title 44.');
  });

  it('omits titles the API reports as missing', async () => {
    const fake: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          query: {
            pages: [
              { title: 'Real Article', extract: 'Some text.' },
              { title: 'Not A Real Article', missing: true },
            ],
          },
        }),
        { status: 200 },
      );

    const result = await fetchExtracts(['Real Article', 'Not A Real Article'], 'en', {
      fetch: fake,
    });

    expect(result.get('Real Article')).toBe('Some text.');
    expect(result.has('Not A Real Article')).toBe(false);
  });

  it('returns an empty map without making a request for an empty title list', async () => {
    let called = false;
    const fake: typeof fetch = async () => {
      called = true;
      return fakeResponse([]);
    };

    const result = await fetchExtracts([], 'en', { fetch: fake });

    expect(called).toBe(false);
    expect(result.size).toBe(0);
  });

  it('deduplicates repeated titles before batching', async () => {
    let requestedTitleCount = 0;
    const fake: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL).href);
      const batch = (url.searchParams.get('titles') ?? '').split('|');
      requestedTitleCount += batch.length;
      return fakeResponse(batch);
    };

    await fetchExtracts(['A', 'A', 'B'], 'en', { fetch: fake });

    expect(requestedTitleCount).toBe(2);
  });
});
