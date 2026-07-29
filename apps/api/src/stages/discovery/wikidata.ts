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
  /** Direct `instance of` labels — "castle", "church building", "square".
   * The type filter walks the subclass graph to decide *whether* an item is a
   * place; these say *what kind*, which is what curation actually reasons
   * about when matching a traveller's interests. */
  types: string[];
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
  return `SELECT DISTINCT ?item ?itemLabel ?lat ?lng ?sitelinks ?enTitle ?localTitle ?directTypeLabel WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${city.centre.lng} ${city.centre.lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  ?item wdt:P31/wdt:P279* ?type .
  VALUES ?type { ${CANDIDATE_TYPES.join(' ')} }
  ?item wdt:P31 ?directType .
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
  directTypeLabel?: { value: string };
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
  const typesByQid = new Map<string, Set<string>>();

  for (const row of data.results.bindings) {
    const qid = qidFromUri(row.item.value);

    // Duplicate rows are expected: an item with two P625 statements, or one
    // matching several ?directType values, produces one row each. Keep the
    // first coordinate seen, but union the types across every row — that is
    // the whole reason a duplicate row carries information.
    const label = row.directTypeLabel?.value;
    if (label !== undefined && !/^Q\d+$/.test(label)) {
      const set = typesByQid.get(qid) ?? new Set<string>();
      set.add(label);
      typesByQid.set(qid, set);
    }

    if (seen.has(qid)) continue;
    seen.set(qid, {
      qid,
      label: row.itemLabel?.value ?? qid,
      lat: Number.parseFloat(row.lat.value),
      lng: Number.parseFloat(row.lng.value),
      sitelinks: Number.parseInt(row.sitelinks.value, 10),
      enTitle: row.enTitle?.value ?? null,
      localTitle: row.localTitle?.value ?? null,
      types: [],
    });
  }

  for (const [qid, candidate] of seen) {
    candidate.types = [...(typesByQid.get(qid) ?? [])].sort();
  }

  return [...seen.values()]
    .sort((a, b) => b.sitelinks - a.sitelinks)
    .slice(0, MAX_CANDIDATES);
}
