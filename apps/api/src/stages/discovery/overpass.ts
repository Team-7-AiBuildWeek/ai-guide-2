import type { CityConfig } from '../../config/cities.ts';
import { fetchWithRetry } from './retry.ts';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'ai-guide-tours/0.1 (prototype; github Team-7-AiBuildWeek/ai-guide-2)';

/** Degrees-per-metre is latitude-dependent for longitude; this is close enough for a bounding box. */
function boundingBox(city: CityConfig): { south: number; west: number; north: number; east: number } {
  const { lat, lng } = city.centre;
  const dLat = city.radiusM / 111_320;
  const dLng = city.radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lng - dLng, north: lat + dLat, east: lng + dLng };
}

function buildOverpassQuery(city: CityConfig): string {
  const { south, west, north, east } = boundingBox(city);
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:25];
(
  node["wikidata"](${bbox});
  way["wikidata"](${bbox});
  relation["wikidata"](${bbox});
);
out tags;`;
}

interface OverpassElement {
  tags?: { wikidata?: string; wheelchair?: string };
}

interface OverpassResponse {
  elements: OverpassElement[];
}

/**
 * Fetches OSM accessibility (`wheelchair`) tags for features within a city's
 * radius, joined on the `wikidata` tag — never on name, which is ambiguous
 * in a city with several historical languages.
 *
 * Overpass is heavily rate-limited and this data is an enhancement, not a
 * requirement: any failure (network, non-2xx after retries, malformed JSON)
 * degrades to an empty map rather than failing the discovery stage. Callers
 * see a missing entry as `wheelchair: null` for that QID.
 */
export async function fetchWheelchairTags(
  city: CityConfig,
  deps: { fetch: typeof fetch },
): Promise<Map<string, string>> {
  try {
    const query = buildOverpassQuery(city);
    const body = new URLSearchParams({ data: query }).toString();

    const res = await fetchWithRetry(deps.fetch, ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body,
    });

    const data = (await res.json()) as OverpassResponse;

    const result = new Map<string, string>();
    for (const element of data.elements) {
      const qid = element.tags?.wikidata;
      const wheelchair = element.tags?.wheelchair;
      if (qid && wheelchair && !result.has(qid)) result.set(qid, wheelchair);
    }
    return result;
  } catch {
    return new Map<string, string>();
  }
}
