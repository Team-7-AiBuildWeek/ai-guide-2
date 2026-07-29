import { fetchWithRetry } from './retry.ts';

const USER_AGENT = 'ai-guide-tours/0.1 (prototype; github Team-7-AiBuildWeek/ai-guide-2)';
const BATCH_SIZE = 20;

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

/**
 * Fetches plain-text intro extracts for a batch of Wikipedia titles, 20
 * titles per request as the API allows. Returns a map from title to extract
 * text; titles that don't resolve to an article are simply absent.
 *
 * Intros only (exintro) — full article text is fetched later, only for the
 * handful of stops that survive curation. That split is a deliberate cost
 * control, not an oversight.
 */
export async function fetchExtracts(
  titles: string[],
  lang: string,
  deps: { fetch: typeof fetch },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueTitles = [...new Set(titles)];
  if (uniqueTitles.length === 0) return result;

  const batches = chunk(uniqueTitles, BATCH_SIZE);
  for (const [index, batch] of batches.entries()) {
    // A short gap between batches is a courtesy to a free, shared API — it
    // costs nothing in replay (no batches are ever >1 in recorded tests) and
    // avoids tripping Wikimedia's rate limiting when recording for real.
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 200));

    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('prop', 'extracts');
    url.searchParams.set('exintro', '1');
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
      result.set(page.title, page.extract);
    }
  }

  return result;
}
