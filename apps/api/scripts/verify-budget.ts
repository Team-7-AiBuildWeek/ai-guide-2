/**
 * One measured experiment: does the distance-budget instruction make curation
 * respect the traveller's time budget?
 *
 * Baseline, without it — the recorded L1 run, asked for 60 minutes:
 *   10 stops, 5165 m, 61.7 min walking, 78.4 min all in.  Over by 31%.
 *
 * Deliberately writes NOTHING to the committed cassettes. A different stop
 * selection would invalidate the recorded route and narration, and replacing
 * those costs another ~$0.44 that is not the question being asked here.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineM, type GenerateRequest } from '@ai-guide/shared';
import { FileCassetteStore, cassetteFetch } from '../src/cassette/index.ts';
import { createRedactingCassetteFetch, resolveMapboxToken } from '../src/stages/routing/mapbox.ts';
import { AnthropicLlmClient } from '../src/llm/anthropic.ts';
import { BRATISLAVA } from '../src/config/cities.ts';
import { discover } from '../src/stages/discovery/index.ts';
import { curate } from '../src/stages/curation/index.ts';
import { route } from '../src/stages/routing/index.ts';
import { walkingBudgetM } from '../src/stages/budget.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', 'cassettes');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY required.');

const store = new FileCassetteStore(cassetteDir);
const replayFetch = cassetteFetch('replay', store, (async () => {
  throw new Error('replay-only fetch attempted a live call');
}) as typeof fetch);
// Routing records: new stops mean a new URL, and Mapbox is free.
const mapboxFetch = createRedactingCassetteFetch('record', store, fetch);
const llm = new AnthropicLlmClient({ apiKey, fetch: cassetteFetch('record', store, fetch) });

const BUDGET_MIN = 60;
const request: GenerateRequest = {
  city: 'bratislava',
  profileText: 'I love baroque architecture and quiet corners, and I have already seen the castle.',
  language: 'sk',
  persona: 'a warm local historian who has lived here all their life',
  budgetMin: BUDGET_MIN,
};

const pois = await discover(BRATISLAVA, { fetch: replayFetch });
console.log(`candidates: ${pois.length}`);
console.log(`budget    : ${BUDGET_MIN} min`);
console.log(`told the model: ~${walkingBudgetM(BUDGET_MIN, 10)} m of walking for 10 stops\n`);

const started = Date.now();
const curation = await curate(pois, request, { llm });
console.log(`curation: ${((Date.now() - started) / 1000).toFixed(0)}s, $${curation.costUsd.toFixed(4)}`);
console.log(`stops   : ${curation.output.stops.length}  — "${curation.output.tourTitle}"`);

const stops = curation.output.stops;
let straight = 0;
for (let i = 1; i < stops.length; i++) {
  straight += haversineM(stops[i - 1].standingPoint, stops[i].standingPoint);
}
console.log(`straight-line path through the stops: ${Math.round(straight)} m`);

const r = await route(stops, BUDGET_MIN, { fetch: mapboxFetch, token: resolveMapboxToken() });
const walkingMin = r.legs.reduce((s, l) => s + l.durationS, 0) / 60;
const distanceM = r.legs.reduce((s, l) => s + l.distanceM, 0);

console.log('\n──────── result ────────');
console.log(`walking distance : ${Math.round(distanceM)} m      (baseline 5165)`);
console.log(`walking time     : ${walkingMin.toFixed(1)} min    (baseline 61.7)`);
console.log(`estimated total  : ${r.estimatedMin.toFixed(1)} min   (baseline 78.4, budget ${BUDGET_MIN})`);
console.log(`overBudget flag  : ${r.overBudget}`);
console.log(
  `\nverdict: ${r.overBudget ? 'STILL OVER — re-curation would fire, doubling cost' : 'within budget — no re-curation, single curation cost'}`,
);
console.log(`cost this run: $${curation.costUsd.toFixed(4)}`);

await writeFile(
  join(here, '..', '..', '..', '.superpowers', 'sdd', '2026-07-28-generation-pipeline', 'budget-verification.json'),
  `${JSON.stringify(
    {
      budgetMin: BUDGET_MIN,
      toldModelMetres: walkingBudgetM(BUDGET_MIN, 10),
      stops: stops.length,
      tourTitle: curation.output.tourTitle,
      straightLineM: Math.round(straight),
      walkingDistanceM: Math.round(distanceM),
      walkingMinutes: Number(walkingMin.toFixed(1)),
      estimatedTotalMin: Number(r.estimatedMin.toFixed(1)),
      overBudget: r.overBudget,
      costUsd: Number(curation.costUsd.toFixed(4)),
      baseline: { stops: 10, walkingDistanceM: 5165, walkingMinutes: 61.7, estimatedTotalMin: 78.4 },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log('\nwrote budget-verification.json (cassettes left untouched)');
process.exit(0);
