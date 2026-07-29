/**
 * Voices the committed Bratislava tour with Chirp 3 HD and writes the audio
 * URLs back into the fixture.
 *
 * After this, the golden tour has real narration attached and the player can
 * use MP3s instead of the browser's on-device speech — the first time anyone
 * hears what this product actually sounds like.
 *
 * Costs characters, not requests, and Chirp's free tier is 1M/month against
 * roughly 23k here. Re-running is nearly free regardless: audio is content
 * addressed, so a second run re-uses every segment whose script has not
 * changed and bills nothing for it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TourSchema, type Tour } from '@ai-guide/shared';
import { ChirpTtsProvider, type ChirpVoice } from '../src/tts/chirp.ts';
import { audioStoreFromEnv } from '../src/tts/supabaseAudioStore.ts';
import { synthesizeTour } from '../src/stages/synthesis/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here, '..', '..', '..', 'packages', 'shared', 'src', 'fixtures', 'bratislava-tour.json',
);

/** Chosen in the toponym spike; a warm, unhurried delivery. */
const VOICE: ChirpVoice = 'Aoede';

const apiKey = process.env.GOOGLE_TTS_API_KEY;
if (!apiKey) throw new Error('GOOGLE_TTS_API_KEY is not set.');

const store = audioStoreFromEnv();
if (!store) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.');

const raw = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown> & {
  tour: unknown;
};
const tour = TourSchema.parse(raw.tour) as Tour;

const characters = tour.segments.reduce((n, s) => n + s.script.length, 0);
console.log(`tour     : ${tour.title}`);
console.log(`language : ${tour.language}   voice: ${VOICE}`);
console.log(`segments : ${tour.segments.length}, ${characters} characters\n`);

const started = Date.now();
const result = await synthesizeTour(
  tour.segments.map((s) => ({ order: s.order, kind: s.kind, title: s.title, script: s.script })),
  { language: tour.language, voice: VOICE },
  { tts: new ChirpTtsProvider({ apiKey }), store },
);

const seconds = (Date.now() - started) / 1000;

const voiced: Tour = {
  ...tour,
  segments: tour.segments.map((s) => ({
    ...s,
    audioUrl: result.audioUrlByOrder.get(s.order) ?? null,
  })),
};

const missing = voiced.segments.filter((s) => s.audioUrl === null);
if (missing.length > 0) {
  throw new Error(`No audio for ${missing.length} segment(s): ${missing.map((s) => s.order).join(', ')}`);
}

await writeFile(
  fixturePath,
  `${JSON.stringify({ ...raw, tour: voiced }, null, 2)}\n`,
  'utf8',
);

console.log(`took ${seconds.toFixed(1)}s`);
console.log(`characters billed : ${result.charactersBilled}  ($${((result.charactersBilled * 30) / 1_000_000).toFixed(4)} at list, $0 inside the free tier)`);
console.log(`segments reused   : ${result.reused}`);
console.log(`\nwrote audioUrl for all ${voiced.segments.length} segments.`);
console.log(voiced.segments[0].audioUrl);

process.exit(0);
