import { describe, it, expect } from 'vitest';
import { BRATISLAVA } from '../../config/cities.ts';
import { fetchWheelchairTags } from './overpass.ts';

describe('fetchWheelchairTags', () => {
  it('joins on the wikidata tag and returns wheelchair values', async () => {
    const fake: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          elements: [
            { tags: { wikidata: 'Q593311', wheelchair: 'limited' } },
            { tags: { wikidata: 'Q239560', wheelchair: 'yes' } },
            { tags: { amenity: 'cafe' } }, // no wikidata tag — must be ignored
          ],
        }),
        { status: 200 },
      );

    const result = await fetchWheelchairTags(BRATISLAVA, { fetch: fake });

    expect(result.get('Q593311')).toBe('limited');
    expect(result.get('Q239560')).toBe('yes');
    expect(result.size).toBe(2);
  });

  it('degrades to an empty map (never throws) when Overpass fails entirely', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('ETIMEDOUT');
    };

    const result = await fetchWheelchairTags(BRATISLAVA, { fetch: fake });

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('degrades to an empty map when Overpass returns a persistent 5xx', async () => {
    const fake: typeof fetch = async () => new Response('server error', { status: 503 });

    const result = await fetchWheelchairTags(BRATISLAVA, { fetch: fake });

    expect(result.size).toBe(0);
  });

  it('degrades to an empty map on malformed JSON', async () => {
    const fake: typeof fetch = async () => new Response('not json', { status: 200 });

    const result = await fetchWheelchairTags(BRATISLAVA, { fetch: fake });

    expect(result.size).toBe(0);
  });
});
