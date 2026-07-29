// Records (or replays, or live-calls without saving) the narration stage's
// full-article Wikipedia extract cassettes for the 8 stops in the synthetic
// Bratislava curation cassette. Run from the repo root:
//
//   $env:CASSETTE_MODE = "record"
//   node --experimental-strip-types apps/api/scripts/record-extracts.ts
//
// This is the only place in the codebase permitted to make a real network
// call for full-article extracts outside of `live` mode — see
// task-8-brief.md. Like discovery's recording script, it never calls the
// Anthropic API: Wikipedia's API is free and needs no key.
//
// Discovery's own cassettes (Wikidata/Wikipedia-intro/Overpass) are replayed
// unchanged here, not re-recorded — this script only adds new cassette
// entries for the full (non-`exintro`) article fetches, so it does not risk
// silently altering the discovery cassettes that other tests already depend
// on.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CuratedStop } from '@ai-guide/shared';
import { BRATISLAVA } from '../src/config/cities.ts';
import { FileCassetteStore, cassetteFetch, resolveCassetteMode } from '../src/cassette/index.ts';
import { discover } from '../src/stages/discovery/index.ts';
import { fetchStopExtracts } from '../src/stages/narration/extracts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', 'cassettes');

async function loadSyntheticStops(): Promise<CuratedStop[]> {
  const raw = await readFile(join(cassetteDir, 'synthetic', 'curation-bratislava.json'), 'utf8');
  const cassette = JSON.parse(raw) as { stops: CuratedStop[] };
  return cassette.stops;
}

async function main(): Promise<void> {
  const mode = resolveCassetteMode();
  const store = new FileCassetteStore(cassetteDir);

  // Discovery's own data is always replayed, regardless of `mode` — this
  // script's job is recording NEW extract cassettes, not re-fetching data
  // other stages already recorded and other tests already depend on.
  const unusedLive: typeof fetch = async () => {
    throw new Error('replay must never call through to a live fetch');
  };
  const discoveryFetch = cassetteFetch('replay', store, unusedLive);
  const pois = await discover(BRATISLAVA, { fetch: discoveryFetch });

  const stops = await loadSyntheticStops();
  console.log(`Fetching full extracts for ${stops.length} stops (cassette mode: ${mode})`);

  const extractFetch = cassetteFetch(mode, store, fetch);
  const extracts = await fetchStopExtracts(stops, pois, BRATISLAVA, { fetch: extractFetch });

  const qidCount = new Set(stops.flatMap((s) => s.wikidataQids)).size;
  console.log(`\n${extracts.size}/${qidCount} QIDs resolved to at least one full-article extract.`);
  for (const [qid, text] of extracts) {
    console.log(`  ${qid}\t${text.length} chars`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
