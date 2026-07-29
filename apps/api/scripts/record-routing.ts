// Records (or replays, or live-calls without saving) the routing stage's
// Mapbox Directions cassette for Bratislava, using the standing points from
// the synthetic curation cassette. Run from the repo root:
//
//   $env:CASSETTE_MODE = "record"
//   node --experimental-strip-types apps/api/scripts/record-routing.ts
//
// This is the only place in the codebase permitted to make a real network
// call to Mapbox outside of `live` mode — see task-7-brief.md. It never
// calls the Anthropic API.
//
// The Mapbox token is read from the environment (MAPBOX_TOKEN, falling back
// to VITE_MAPBOX_TOKEN) and is NEVER logged, printed, or included in any
// error message this script produces — see mapbox.ts's
// createRedactingCassetteFetch, which strips it before the cassette layer
// ever computes a key or filename from the request URL.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CuratedStop } from '@ai-guide/shared';
import { FileCassetteStore, resolveCassetteMode } from '../src/cassette/index.ts';
import { createRedactingCassetteFetch, resolveMapboxToken } from '../src/stages/routing/mapbox.ts';
import { route } from '../src/stages/routing/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const cassetteDir = join(here, '..', 'cassettes');

/**
 * Loads KEY=VALUE pairs from `.env.local` into `process.env`, without ever
 * printing a value. Existing environment variables take precedence — this
 * only fills in gaps, the same way a shell-exported var normally would.
 */
async function loadEnvLocal(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.env.local'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function loadSyntheticStops(): Promise<CuratedStop[]> {
  const raw = await readFile(join(cassetteDir, 'synthetic', 'curation-bratislava.json'), 'utf8');
  const cassette = JSON.parse(raw) as { stops: CuratedStop[] };
  return cassette.stops;
}

const BUDGET_MIN = 90;

async function main(): Promise<void> {
  await loadEnvLocal();

  const mode = resolveCassetteMode();
  const token = resolveMapboxToken();
  const store = new FileCassetteStore(cassetteDir);
  const fetchImpl = createRedactingCassetteFetch(mode, store, fetch);

  const stops = await loadSyntheticStops();
  console.log(`Routing ${stops.length} stops for Bratislava (cassette mode: ${mode})`);

  const result = await route(stops, BUDGET_MIN, { fetch: fetchImpl, token });

  const totalDistanceM = result.legs.reduce((sum, leg) => sum + leg.distanceM, 0);
  const totalWalkingMin = result.legs.reduce((sum, leg) => sum + leg.durationS, 0) / 60;

  console.log(`\nRoute: ${result.legs.length} legs, ${result.line.coordinates.length} points.`);
  console.log(`Total walking distance: ${totalDistanceM.toFixed(0)} m`);
  console.log(`Total walking duration: ${totalWalkingMin.toFixed(1)} min`);
  console.log(`Estimated tour duration (incl. dwell): ${result.estimatedMin.toFixed(1)} min`);
  console.log(`Budget: ${BUDGET_MIN} min — overBudget: ${result.overBudget}`);
  console.log(`Trigger radii (m): ${result.triggerRadiiM.map((r) => r.toFixed(1)).join(', ')}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
