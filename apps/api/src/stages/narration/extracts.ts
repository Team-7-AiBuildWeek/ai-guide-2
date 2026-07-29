import type { CuratedStop, Poi } from '@ai-guide/shared';
import type { CityConfig } from '../../config/cities.ts';
import { fetchWithRetry } from '../discovery/retry.ts';

const USER_AGENT = 'ai-guide-tours/0.1 (prototype; github Team-7-AiBuildWeek/ai-guide-2)';

/**
 * ONE title per request, not discovery's 20 — measured against the live API.
 * TextExtracts applies a total-response-size budget per call, not a
 * per-title one, when `exintro` is absent: batching multiple FULL articles
 * in one request silently returns an extract for only the first title and
 * nothing for the rest (no error, no "missing" flag — the field is simply
 * absent). Intro-only extracts are short enough that discovery's 20-per-
 * batch never hits this; full articles are not.
 */
const BATCH_SIZE = 1;

/** Beyond this a Wikipedia article is usually reference lists, not prose. */
export const MAX_EXTRACT_CHARS = 6000;

interface WikipediaPage {
  title: string;
  extract?: string;
  missing?: boolean;
}

interface WikipediaQueryResponse {
  query?: { pages?: WikipediaPage[] };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Truncates to `MAX_EXTRACT_CHARS`; a no-op for anything already shorter. */
export function truncateExtract(text: string, maxChars: number = MAX_EXTRACT_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * Fetches FULL plain-text article bodies (no `exintro`) for a batch of
 * Wikipedia titles, 20 per request. This is discovery's `fetchExtracts`
 * shape without the intro-only restriction — narration needs the whole
 * article, but only for the handful of stops curation kept, which is why
 * this lives here rather than being a shared helper with a flag.
 */
export async function fetchFullText(
  titles: string[],
  lang: string,
  deps: { fetch: typeof fetch },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueTitles = [...new Set(titles)];
  if (uniqueTitles.length === 0) return result;

  const batches = chunk(uniqueTitles, BATCH_SIZE);
  for (const [index, batch] of batches.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 200));

    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('prop', 'extracts');
    url.searchParams.set('explaintext', '1');
    url.searchParams.set('titles', batch.join('|'));
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');

    const res = await fetchWithRetry(deps.fetch, url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    const data = (await res.json()) as WikipediaQueryResponse;
    for (const page of data.query?.pages ?? []) {
      if (page.missing || page.extract === undefined) continue;
      result.set(page.title, truncateExtract(page.extract));
    }
  }

  return result;
}

/**
 * Fetches full article text for the stops that survived curation only —
 * discovery already attached intro paragraphs to ~150 candidates, but
 * sending full articles for all of them would multiply the input cost for
 * material that was never going to be used.
 *
 * Fetches BOTH the English and the city's local-language article where each
 * exists (not just one): local buildings routinely have a local article and
 * no English one. Returns a map keyed by wikidataQid, one entry per QID that
 * resolved to at least one article, concatenating the English and local
 * bodies (each independently truncated) when both exist.
 */
export async function fetchStopExtracts(
  stops: CuratedStop[],
  pois: Poi[],
  city: CityConfig,
  deps: { fetch: typeof fetch },
): Promise<Map<string, string>> {
  const poiByQid = new Map(pois.map((p) => [p.wikidataQid, p]));

  const qids = [...new Set(stops.flatMap((s) => s.wikidataQids))];
  const enTitles: string[] = [];
  const localTitles: string[] = [];
  for (const qid of qids) {
    const poi = poiByQid.get(qid);
    if (poi === undefined) continue;
    if (poi.wikiEnTitle !== null) enTitles.push(poi.wikiEnTitle);
    if (poi.wikiLocalTitle !== null) localTitles.push(poi.wikiLocalTitle);
  }

  // Sequential, not parallel, out of the same courtesy discovery observes
  // toward a free, shared API (see fetchFullText's inter-batch delay).
  const enFull = await fetchFullText(enTitles, 'en', deps);
  const localFull =
    city.localLanguage === 'en' ? new Map<string, string>() : await fetchFullText(localTitles, city.localLanguage, deps);

  const result = new Map<string, string>();
  for (const qid of qids) {
    const poi = poiByQid.get(qid);
    if (poi === undefined) continue;

    const parts: string[] = [];
    if (poi.wikiEnTitle !== null && enFull.has(poi.wikiEnTitle)) {
      parts.push(enFull.get(poi.wikiEnTitle) as string);
    }
    if (poi.wikiLocalTitle !== null && localFull.has(poi.wikiLocalTitle)) {
      parts.push(localFull.get(poi.wikiLocalTitle) as string);
    }
    if (parts.length > 0) result.set(qid, parts.join('\n\n'));
  }

  return result;
}
