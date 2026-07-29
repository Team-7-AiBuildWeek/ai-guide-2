/**
 * L1 — record real curation and narration cassettes.
 *
 * This is the first contact between the prompts and Claude Opus 5. Everything
 * downstream of curation has so far been tested against hand-authored
 * fixtures that were written to satisfy the very validators they are checked
 * against, which is circular by construction. This script breaks that loop.
 *
 * Costs real money. Everything except Anthropic stays on `replay`, so no
 * other API is re-recorded and the only variable is the model.
 *
 *   LLM_MODE is irrelevant here — this script always calls live.
 *   Requires ANTHROPIC_API_KEY.
 */
import { writeFile, readFile as readFileFn } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineM } from '@ai-guide/shared';
import type { GenerateRequest, CurationOutput } from '@ai-guide/shared';
import { FileCassetteStore, cassetteFetch } from '../src/cassette/index.ts';
import { createRedactingCassetteFetch, resolveMapboxToken } from '../src/stages/routing/mapbox.ts';
import { AnthropicLlmClient } from '../src/llm/anthropic.ts';
import { BRATISLAVA } from '../src/config/cities.ts';
import { discover } from '../src/stages/discovery/index.ts';
import { curate } from '../src/stages/curation/index.ts';
import { route } from '../src/stages/routing/index.ts';
import { narrate, fetchStopExtracts } from '../src/stages/narration/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', 'cassettes');
const syntheticDir = join(cassetteDir, 'synthetic');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for L1.');

const store = new FileCassetteStore(cassetteDir);

// Everything except Anthropic replays: this run must not silently re-record
// Wikidata, Wikipedia, Overpass or Mapbox.
const replayFetch = cassetteFetch('replay', store, (async () => {
  throw new Error('replay-only fetch attempted a live call');
}) as typeof fetch);
const mapboxFetch = createRedactingCassetteFetch('replay', store, (async () => {
  throw new Error('replay-only mapbox fetch attempted a live call');
}) as typeof fetch);

// Wikipedia full-article extracts DO record: they are free, need no key, and
// the recorded set covers the old stops rather than whatever the model has
// just chosen. Discovery stays on replay above — only these are new.
const extractsFetch = cassetteFetch('record', store, fetch);

// The one paid live path.
const anthropicFetch = cassetteFetch('record', store, fetch);
const llm = new AnthropicLlmClient({ apiKey, fetch: anthropicFetch });

const request: GenerateRequest = {
  city: 'bratislava',
  profileText: 'I love baroque architecture and quiet corners, and I have already seen the castle.',
  language: 'sk',
  persona: 'a warm local historian who has lived here all their life',
  // 90, not 60. The recorded route for these stops is 61.7 minutes of walking
  // and 78 minutes all in, so a 60-minute request trips the over-budget
  // re-curation — a second full curation call at ~$0.32 that teaches nothing
  // new about narration, which is what this run exists to record.
  budgetMin: 90,
};

/** Reuse the curation already paid for, instead of buying it again. */
const reuseCuration = process.env.REUSE_CURATION === '1';

function rule(label: string) {
  console.log(`\n${'─'.repeat(64)}\n${label}\n${'─'.repeat(64)}`);
}

rule('L1 — live generation against claude-opus-5');
console.log(`profile : ${request.profileText}`);
console.log(`persona : ${request.persona}`);
console.log(`language: ${request.language}   budget: ${request.budgetMin} min`);

const pois = await discover(BRATISLAVA, { fetch: replayFetch });
console.log(`\ndiscovery: ${pois.length} candidates (from cassette)`);

let totalCost = 0;

rule(reuseCuration ? 'Stage 2 — curation (REUSED from disk, no call)' : 'Stage 2 — curation (LIVE)');
const started = Date.now();
const curation = reuseCuration
  ? {
      output: JSON.parse(
        await readFileFn(join(syntheticDir, 'curation-bratislava.json'), 'utf8'),
      ) as CurationOutput,
      costUsd: 0,
    }
  : await curate(pois, request, { llm });
totalCost += curation.costUsd;
console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s, cost $${curation.costUsd.toFixed(4)}`);
console.log(`title: ${curation.output.tourTitle}`);
console.log(`stops: ${curation.output.stops.length}`);

const validQids = new Set(pois.map((p) => p.wikidataQid));
for (const s of curation.output.stops) {
  const unknown = s.wikidataQids.filter((q) => !validQids.has(q));
  console.log(
    `  ${String(s.order).padStart(2)}  ${s.title.padEnd(34).slice(0, 34)}  ${s.wikidataQids.join(',')}${unknown.length ? `  !! NOT IN CANDIDATES: ${unknown.join(',')}` : ''}`,
  );
}

// The constraint most likely to be genuinely hard in a 1km old town.
let minPair = Infinity;
let minPairLabel = '';
const stops = curation.output.stops;
for (let i = 0; i < stops.length; i++) {
  for (let j = i + 1; j < stops.length; j++) {
    const d = haversineM(stops[i].standingPoint, stops[j].standingPoint);
    if (d < minPair) {
      minPair = d;
      minPairLabel = `${stops[i].title} <-> ${stops[j].title}`;
    }
  }
}
console.log(`\nclosest pair: ${Math.round(minPair)}m  (${minPairLabel})   [floor is 100m]`);

rule('Stage 3 — routing (cassette, may miss on new stops)');
let routeResult;
try {
  routeResult = await route(curation.output.stops, request.budgetMin, {
    fetch: mapboxFetch,
    token: resolveMapboxToken(),
  });
  console.log(`route ok: ${routeResult.legs.length} legs, est ${routeResult.estimatedMin.toFixed(1)} min`);
} catch (err) {
  console.log(`routing could not replay (expected if the model picked different stops):`);
  console.log(`  ${(err as Error).message.slice(0, 160)}`);
  console.log(`\nRe-run apps/api/scripts/record-routing.ts once the new curation is saved.`);
  await saveCuration();
  process.exit(0);
}

rule('Stage 4 — narration (LIVE)');
const extracts = await fetchStopExtracts(curation.output.stops, pois, BRATISLAVA, { fetch: extractsFetch });
console.log(`extracts: ${extracts.size} articles`);
const narrationStarted = Date.now();
const narration = await narrate(curation.output.stops, extracts, routeResult, request, { llm });
totalCost += narration.costUsd;
console.log(`took ${((Date.now() - narrationStarted) / 1000).toFixed(1)}s, cost $${narration.costUsd.toFixed(4)}`);

const segs = narration.output.segments;
const expected = 2 * curation.output.stops.length + 1;
console.log(`segments: ${segs.length} (expected ${expected})`);
console.log(`kinds   : ${segs.map((s) => s.kind[0]).join('')}`);

const stopLens = segs.filter((s) => s.kind === 'stop').map((s) => s.script.length);
const walkLens = segs.filter((s) => s.kind === 'walk').map((s) => s.script.length);
const range = (a: number[]) => (a.length ? `${Math.min(...a)}–${Math.max(...a)}` : 'n/a');
console.log(`stop script lengths: ${range(stopLens)}  [bounds 400–1400]`);
console.log(`walk script lengths: ${range(walkLens)}  [bounds 120–350]`);

rule('Sample of the actual Slovak narration');
for (const s of segs.slice(0, 4)) {
  console.log(`\n[${s.order}] ${s.kind} — ${s.title}`);
  console.log(s.script);
}

await saveCuration();
await writeFile(
  join(syntheticDir, 'narration-bratislava-sk.json'),
  `${JSON.stringify({ _synthetic: false, _comment: `Recorded from claude-opus-5 on ${new Date().toISOString()} — real model output, not hand-authored.`, segments: segs }, null, 2)}\n`,
  'utf8',
);

rule('Total');
console.log(`cost this run: $${totalCost.toFixed(4)}`);

async function saveCuration() {
  await writeFile(
    join(syntheticDir, 'curation-bratislava.json'),
    `${JSON.stringify({ _synthetic: false, _comment: `Recorded from claude-opus-5 on ${new Date().toISOString()} — real model output, not hand-authored.`, tourTitle: curation.output.tourTitle, stops: curation.output.stops }, null, 2)}\n`,
    'utf8',
  );
  console.log('\nwrote curation-bratislava.json');
}

process.exit(0);
