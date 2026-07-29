/**
 * The toponym spike — the half-day listening test that decides the voice
 * vendor, and which the spec says must happen BEFORE any TTS integration is
 * written.
 *
 * The question: can a voice with no Slovak phonology say *Hviezdoslavovo
 * námestie* well enough that a tourist can find the place?
 *
 * Every tour is saturated with local toponyms in a language that is not the
 * narration language — a Spanish tour of Bratislava must still say Michalská
 * brána, because that is what the street signs say. Slovak orthography (ľ, ť,
 * ď, ň, č, š, ž, and heavy consonant clusters) in voices built for Spanish or
 * German is the harshest version of this problem we could have picked, which
 * is why the city choice front-loaded the risk rather than deferring it.
 *
 * Slovak is the CONTROL. It is the only voice that pronounces these correctly
 * by construction, so it defines what the others should sound like. Judge the
 * rest against it, not against your own expectations.
 *
 * Writes MP3s to apps/api/spike-audio/ (gitignored). Listen to them. There is
 * no automated assertion here and there cannot be — the whole output is a
 * judgement no test can make.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChirpTtsProvider, chirpVoiceName, type ChirpVoice } from '../src/tts/chirp.ts';
import type { TtsProvider } from '../src/tts/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'spike-audio');

/** Real names from the recorded Bratislava tour, worst offenders first. */
const TOPONYMS = [
  'Hviezdoslavovo námestie',
  'Františkánske námestie',
  'Michalská brána',
  'Primaciálny palác',
  'Ventúrska ulica',
  'Rybárska brána',
  'Dóm svätého Martina',
  'Hlavné námestie',
];

/**
 * A toponym inside a real sentence, in each narration language.
 *
 * Isolated words are the easy case. What actually matters is a name embedded
 * in another language's prosody, where the voice has to switch mid-clause and
 * switch back — which is exactly where code-switching breaks down.
 */
const IN_CONTEXT: Record<string, string> = {
  'sk-SK': 'Stojíme pod Michalskou bránou, na konci Ventúrskej ulice, kúsok od Hlavného námestia.',
  'de-DE':
    'Wir stehen unter der Michalská brána, am Ende der Ventúrska ulica, nicht weit vom Hlavné námestie.',
  'es-ES':
    'Estamos bajo la Michalská brána, al final de la Ventúrska ulica, cerca del Hlavné námestie.',
  'it-IT':
    'Siamo sotto la Michalská brána, alla fine di Ventúrska ulica, poco lontano da Hlavné námestie.',
};

const LANGUAGES = ['sk-SK', 'de-DE', 'es-ES', 'it-IT'];
const VOICE: ChirpVoice = 'Aoede';

async function run(provider: TtsProvider, label: string): Promise<number> {
  let characters = 0;

  for (const languageCode of LANGUAGES) {
    const control = languageCode === 'sk-SK' ? ' (CONTROL)' : '';

    // One file per language with every name read in sequence — easier to
    // A/B against the control than eight separate files.
    const list = TOPONYMS.join('. ') + '.';
    for (const [what, text] of [
      ['names', list],
      ['sentence', IN_CONTEXT[languageCode]],
    ] as const) {
      const result = await provider.synthesize({
        text,
        languageCode,
        voice: chirpVoiceName(languageCode, VOICE),
      });
      characters += result.characters;

      const file = join(outDir, `${label}-${languageCode}-${what}.mp3`);
      await writeFile(file, result.audio);
      console.log(`  ${languageCode}${control} ${what.padEnd(8)} -> ${file}`);
    }
  }

  return characters;
}

const apiKey = process.env.GOOGLE_TTS_API_KEY;
if (!apiKey) {
  throw new Error(
    'GOOGLE_TTS_API_KEY is not set. Google Cloud console -> enable Cloud Text-to-Speech API -> Credentials -> Create API key.',
  );
}

await mkdir(outDir, { recursive: true });

console.log('Toponym spike — Chirp 3 HD');
console.log(`voice: ${VOICE}, languages: ${LANGUAGES.join(', ')}\n`);

const characters = await run(new ChirpTtsProvider({ apiKey }), 'chirp');

console.log(`\ncharacters synthesised: ${characters}`);
console.log(`cost at $30/1M: $${((characters * 30) / 1_000_000).toFixed(4)}`);
console.log(`(Chirp's free tier is 1M characters/month, so this should be $0.)`);
console.log(`\nNow LISTEN to ${outDir}.`);
console.log('Judge the non-Slovak voices against the sk-SK control, not against');
console.log('your expectations. The question is whether a tourist could find the');
console.log('place from what they hear — not whether it sounds native.');

process.exit(0);
