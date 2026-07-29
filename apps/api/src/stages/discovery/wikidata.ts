import type { CityConfig } from '../../config/cities.ts';
import { fetchWithRetry } from './retry.ts';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'ai-guide-tours/0.1 (prototype; github Team-7-AiBuildWeek/ai-guide-2)';

/** Places we'll consider as candidate stops: buildings, parks, squares, museums. */
const CANDIDATE_TYPES = ['wd:Q811979', 'wd:Q4989906', 'wd:Q174782', 'wd:Q33506'];

const MAX_CANDIDATES = 150;

export interface WikidataCandidate {
  qid: string;
  /** Best label from the Wikidata label service (en, falling back to the local language). */
  label: string;
  lat: number;
  lng: number;
  sitelinks: number;
  enTitle: string | null;
  localTitle: string | null;
}

/**
 * Builds the validated discovery SPARQL query for a city.
 *
 * This is the query from task-5-brief.md, measured against the live
 * endpoint, with the centre point, radius and local-language wiki
 * substituted in. Its shape (the `SERVICE wikibase:around`, the type
 * filter, the sitelink join, the label service) must not change — do not
 * add an `ORDER BY`; a run that added one produced a 502 where the
 * unmodified query succeeded. Sorting happens client-side instead.
 */
export function buildDiscoveryQuery(city: CityConfig): string {
  const radiusKm = city.radiusM / 1000;
  const lang = city.localLanguage;
  return `SELECT DISTINCT ?item ?itemLabel ?lat ?lng ?sitelinks ?enTitle ?localTitle WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${city.centre.lng} ${city.centre.lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  ?item wdt:P31/wdt:P279* ?type .
  VALUES ?type { ${CANDIDATE_TYPES.join(' ')} }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= 2)
  ?item p:P625/psv:P625 ?coordNode .
  ?coordNode wikibase:geoLatitude ?lat .
  ?coordNode wikibase:geoLongitude ?lng .
  OPTIONAL {
    ?enSitelink schema:about ?item ;
                schema:isPartOf <https://en.wikipedia.org/> ;
                schema:name ?enTitle .
  }
  OPTIONAL {
    ?localSitelink schema:about ?item ;
                schema:isPartOf <https://${lang}.wikipedia.org/> ;
                schema:name ?localTitle .
  }
  FILTER(BOUND(?enTitle) || BOUND(?localTitle))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,${lang}". }
}`;
}

interface SparqlBinding {
  item: { value: string };
  itemLabel?: { value: string };
  lat: { value: string };
  lng: { value: string };
  sitelinks: { value: string };
  enTitle?: { value: string };
  localTitle?: { value: string };
}

interface SparqlResponse {
  results: { bindings: SparqlBinding[] };
}

function qidFromUri(uri: string): string {
  const match = /Q\d+$/.exec(uri);
  if (!match) throw new Error(`Could not extract a QID from ${uri}`);
  return match[0];
}

/**
 * Fetches candidate POIs for a city from Wikidata: runs the validated SPARQL
 * query, deduplicates rows on QID (SELECT DISTINCT does not dedupe items
 * that carry more than one P625 coordinate statement), sorts by sitelink
 * count descending, and caps the result at 150.
 */
export async function fetchWikidataCandidates(
  city: CityConfig,
  deps: { fetch: typeof fetch },
): Promise<WikidataCandidate[]> {
  const query = buildDiscoveryQuery(city);
  const body = new URLSearchParams({ query, format: 'json' }).toString();

  const res = await fetchWithRetry(deps.fetch, ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'User-Agent': USER_AGENT,
    },
    body,
  });

  const data = (await res.json()) as SparqlResponse;

  const seen = new Map<string, WikidataCandidate>();
  for (const row of data.results.bindings) {
    const qid = qidFromUri(row.item.value);
    // Keep the first coordinate seen for a given QID — later duplicate rows
    // (a second P625 statement, or a second matched ?type) are dropped.
    if (seen.has(qid)) continue;
    seen.set(qid, {
      qid,
      label: row.itemLabel?.value ?? qid,
      lat: Number.parseFloat(row.lat.value),
      lng: Number.parseFloat(row.lng.value),
      sitelinks: Number.parseInt(row.sitelinks.value, 10),
      enTitle: row.enTitle?.value ?? null,
      localTitle: row.localTitle?.value ?? null,
    });
  }

  return [...seen.values()]
    .sort((a, b) => b.sitelinks - a.sitelinks)
    .slice(0, MAX_CANDIDATES);
}
