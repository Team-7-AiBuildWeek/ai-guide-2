import type { Poi } from '@ai-guide/shared';
import type { CityConfig } from '../../config/cities.ts';
import { fetchWikidataCandidates, type WikidataCandidate } from './wikidata.ts';
import { fetchExtracts } from './wikipedia.ts';
import { fetchWheelchairTags } from './overpass.ts';

export { fetchWikidataCandidates, buildDiscoveryQuery } from './wikidata.ts';
export type { WikidataCandidate } from './wikidata.ts';
export { fetchExtracts } from './wikipedia.ts';
export { fetchWheelchairTags } from './overpass.ts';
export { fetchWithRetry } from './retry.ts';

/**
 * Turns Wikidata candidates into full Poi records: attaches Wikipedia intro
 * extracts (en + the city's local language) and OSM wheelchair-accessibility
 * tags. Split out from `discover` so callers that already hold the
 * candidates (e.g. the recording script, which wants sitelink counts for
 * reporting) don't have to issue a second, redundant SPARQL query.
 */
export async function assemblePois(
  candidates: WikidataCandidate[],
  city: CityConfig,
  deps: { fetch: typeof fetch },
): Promise<Poi[]> {
  const enTitles = candidates.map((c) => c.enTitle).filter((t): t is string => t !== null);
  const localTitles = candidates.map((c) => c.localTitle).filter((t): t is string => t !== null);

  // Wikipedia's en and local-language extracts are fetched sequentially
  // (rather than in parallel) to avoid bursting Wikimedia's rate limiting;
  // Overpass is a different host and runs concurrently with both.
  const wheelchairPromise = fetchWheelchairTags(city, deps);
  const enExtracts = await fetchExtracts(enTitles, 'en', deps);
  const localExtracts = await fetchExtracts(localTitles, city.localLanguage, deps);
  const wheelchairByQid = await wheelchairPromise;

  return candidates.map((c) => {
    const names: Record<string, string> = { en: c.enTitle ?? c.label };
    names[city.localLanguage] = c.localTitle ?? c.label;

    return {
      wikidataQid: c.qid,
      names,
      point: { lat: c.lat, lng: c.lng },
      // Direct `instance of` labels: "castle", "cathedral", "square". The
      // subclass-graph filter decides *whether* an item is a place; these say
      // *what kind*, which is what curation matches against a traveller's
      // stated interests.
      p31Types: c.types,
      wikiEnTitle: c.enTitle,
      wikiLocalTitle: c.localTitle,
      summaryEn: c.enTitle ? (enExtracts.get(c.enTitle) ?? null) : null,
      summaryLocal: c.localTitle ? (localExtracts.get(c.localTitle) ?? null) : null,
      wheelchair: wheelchairByQid.get(c.qid) ?? null,
    };
  });
}

/**
 * Builds the candidate POI set for a city from Wikidata, Wikipedia and
 * OpenStreetMap. Run once per city and cached — never in the per-tour
 * request path.
 */
export async function discover(city: CityConfig, deps: { fetch: typeof fetch }): Promise<Poi[]> {
  const candidates = await fetchWikidataCandidates(city, deps);
  return assemblePois(candidates, city, deps);
}
