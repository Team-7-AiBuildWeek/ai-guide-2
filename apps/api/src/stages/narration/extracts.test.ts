import { describe, it, expect } from 'vitest';
import type { CuratedStop, Poi } from '@ai-guide/shared';
import type { CityConfig } from '../../config/cities.ts';
import { fetchFullText, fetchStopExtracts, truncateExtract, MAX_EXTRACT_CHARS } from './extracts.ts';

const CITY: CityConfig = {
  slug: 'bratislava',
  name: 'Bratislava',
  localLanguage: 'sk',
  centre: { lat: 48.1436, lng: 17.1085 },
  radiusM: 1000,
};

function fakeResponse(titles: string[], extractFor: (title: string) => string): Response {
  const pages = titles.map((title) => ({ title, extract: extractFor(title) }));
  return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
}

function makePoi(overrides: Partial<Poi> = {}): Poi {
  return {
    wikidataQid: 'Q1',
    names: { en: 'Test Place' },
    point: { lat: 48.14, lng: 17.1 },
    p31Types: ['castle'],
    wikiEnTitle: null,
    wikiLocalTitle: null,
    summaryEn: null,
    summaryLocal: null,
    wheelchair: null,
    ...overrides,
  };
}

function makeStop(qids: string[], order = 0): CuratedStop {
  return {
    wikidataQids: qids,
    standingPoint: { lat: 48.14, lng: 17.1 },
    title: 'Test Stop',
    why: 'x',
    order,
  };
}

describe('fetchFullText', () => {
  it('requests full article text, not the intro-only variant', async () => {
    let capturedUrl: URL | undefined;
    const fake: typeof fetch = async (input) => {
      capturedUrl = new URL(typeof input === 'string' ? input : (input as URL).href);
      return fakeResponse(['Article'], () => 'x'.repeat(20));
    };

    await fetchFullText(['Article'], 'en', { fetch: fake });

    expect(capturedUrl?.searchParams.get('exintro')).toBeNull();
    expect(capturedUrl?.searchParams.get('explaintext')).toBe('1');
  });

  it('truncates article text to MAX_EXTRACT_CHARS', async () => {
    const longText = 'x'.repeat(MAX_EXTRACT_CHARS + 5000);
    const fake: typeof fetch = async () => fakeResponse(['Long Article'], () => longText);

    const result = await fetchFullText(['Long Article'], 'en', { fetch: fake });

    expect(result.get('Long Article')?.length).toBe(MAX_EXTRACT_CHARS);
  });

  it('does not truncate text already under the limit', async () => {
    const shortText = 'x'.repeat(100);
    const fake: typeof fetch = async () => fakeResponse(['Short'], () => shortText);

    const result = await fetchFullText(['Short'], 'en', { fetch: fake });

    expect(result.get('Short')).toBe(shortText);
  });

  it('omits titles reported missing', async () => {
    const fake: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          query: { pages: [{ title: 'Real', extract: 'text' }, { title: 'Fake', missing: true }] },
        }),
        { status: 200 },
      );

    const result = await fetchFullText(['Real', 'Fake'], 'en', { fetch: fake });

    expect(result.has('Real')).toBe(true);
    expect(result.has('Fake')).toBe(false);
  });
});

describe('truncateExtract', () => {
  it('truncates to the given length', () => {
    expect(truncateExtract('x'.repeat(20), 10)).toHaveLength(10);
  });

  it('leaves short text untouched', () => {
    expect(truncateExtract('short', 10)).toBe('short');
  });
});

describe('fetchStopExtracts', () => {
  it('fetches both English and local-language articles when both exist', async () => {
    const pois = [makePoi({ wikidataQid: 'Q1', wikiEnTitle: 'Castle', wikiLocalTitle: 'Hrad' })];
    const stops = [makeStop(['Q1'])];

    const requestedLangs: string[] = [];
    const fake: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL).href);
      requestedLangs.push(url.hostname);
      const titles = (url.searchParams.get('titles') ?? '').split('|');
      return fakeResponse(titles, (t) => `Full text of ${t}.`);
    };

    const result = await fetchStopExtracts(stops, pois, CITY, { fetch: fake });

    expect(requestedLangs).toContain('en.wikipedia.org');
    expect(requestedLangs).toContain('sk.wikipedia.org');
    const combined = result.get('Q1');
    expect(combined).toContain('Full text of Castle.');
    expect(combined).toContain('Full text of Hrad.');
  });

  it('fetches only the English article when no local title exists', async () => {
    const pois = [makePoi({ wikidataQid: 'Q2', wikiEnTitle: 'SoloArticle', wikiLocalTitle: null })];
    const stops = [makeStop(['Q2'])];

    const fake: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL).href);
      const titles = (url.searchParams.get('titles') ?? '').split('|');
      return fakeResponse(titles, (t) => `Full text of ${t}.`);
    };

    const result = await fetchStopExtracts(stops, pois, CITY, { fetch: fake });

    expect(result.get('Q2')).toBe('Full text of SoloArticle.');
  });

  it('fetches only the local article when no English title exists (e.g. Jakubov dom)', async () => {
    const pois = [makePoi({ wikidataQid: 'Q3', wikiEnTitle: null, wikiLocalTitle: 'LocalOnly' })];
    const stops = [makeStop(['Q3'])];

    const fake: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL).href);
      const titles = (url.searchParams.get('titles') ?? '').split('|');
      return fakeResponse(titles, (t) => `Full text of ${t}.`);
    };

    const result = await fetchStopExtracts(stops, pois, CITY, { fetch: fake });

    expect(result.get('Q3')).toBe('Full text of LocalOnly.');
  });

  it('covers every QID a stop lists, not just the first', async () => {
    const pois = [
      makePoi({ wikidataQid: 'Q10', wikiEnTitle: 'Fountain', wikiLocalTitle: null }),
      makePoi({ wikidataQid: 'Q11', wikiEnTitle: 'TownHall', wikiLocalTitle: null }),
    ];
    const stops = [makeStop(['Q10', 'Q11'])];

    const fake: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL).href);
      const titles = (url.searchParams.get('titles') ?? '').split('|');
      return fakeResponse(titles, (t) => `Full text of ${t}.`);
    };

    const result = await fetchStopExtracts(stops, pois, CITY, { fetch: fake });

    expect(result.has('Q10')).toBe(true);
    expect(result.has('Q11')).toBe(true);
  });

  it('fetches only the selected stops worth of titles, not every candidate POI', async () => {
    const selected = makePoi({ wikidataQid: 'Q1', wikiEnTitle: 'Selected', wikiLocalTitle: null });
    const notSelected = makePoi({ wikidataQid: 'Q2', wikiEnTitle: 'NotSelected', wikiLocalTitle: null });
    const stops = [makeStop(['Q1'])];

    const requestedTitles: string[] = [];
    const fake: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as URL).href);
      const titles = (url.searchParams.get('titles') ?? '').split('|');
      requestedTitles.push(...titles);
      return fakeResponse(titles, (t) => `Full text of ${t}.`);
    };

    await fetchStopExtracts(stops, [selected, notSelected], CITY, { fetch: fake });

    expect(requestedTitles).toContain('Selected');
    expect(requestedTitles).not.toContain('NotSelected');
  });
});
