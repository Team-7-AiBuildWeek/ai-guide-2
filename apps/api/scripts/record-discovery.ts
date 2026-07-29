// Records (or replays, or live-calls without saving) the discovery stage's
// cassettes for Bratislava. Run from the repo root:
//
//   $env:CASSETTE_MODE = "record"
//   node --experimental-strip-types apps/api/scripts/record-discovery.ts
//
// This is the only place in the codebase permitted to make a real network
// call to Wikidata, Wikipedia or Overpass outside of `live` mode — see
// task-5-brief.md. It never calls the Anthropic API.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRATISLAVA } from '../src/config/cities.ts';
import { cassetteFetch, FileCassetteStore, resolveCassetteMode } from '../src/cassette/index.ts';
import { fetchWikidataCandidates, assemblePois } from '../src/stages/discovery/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', 'cassettes');

async function main(): Promise<void> {
  const mode = resolveCassetteMode();
  const store = new FileCassetteStore(cassetteDir);
  const fetchImpl = cassetteFetch(mode, store, fetch);

  console.log(`Discovering POIs for ${BRATISLAVA.name} (cassette mode: ${mode})`);

  const candidates = await fetchWikidataCandidates(BRATISLAVA, { fetch: fetchImpl });
  const pois = await assemblePois(candidates, BRATISLAVA, { fetch: fetchImpl });

  console.log(`\nDiscovered ${pois.length} POIs (${candidates.length} candidates after dedupe/cap).`);
  console.log('\nTop 10 by sitelink count:');
  for (const c of candidates.slice(0, 10)) {
    const name = c.enTitle ?? c.localTitle ?? c.label;
    console.log(`  ${c.qid}\t${c.sitelinks}\t${name}`);
  }

  const withSummaryEn = pois.filter((p) => p.summaryEn !== null).length;
  const withWheelchair = pois.filter((p) => p.wheelchair !== null).length;
  console.log(`\n${withSummaryEn}/${pois.length} have an English summary.`);
  console.log(`${withWheelchair}/${pois.length} have a wheelchair tag from OSM.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
