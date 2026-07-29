import type { NarrationOutput } from '@ai-guide/shared';
import type { TtsProvider } from '../../tts/types.ts';
import { audioKey, type AudioStore } from '../../tts/audioStore.ts';
import { chirpVoiceName, type ChirpVoice } from '../../tts/chirp.ts';

/**
 * Our language codes are ISO 639-1 ('sk'); TTS wants BCP-47 ('sk-SK').
 *
 * Explicit rather than derived, because the mapping is not mechanical —
 * English has no `en-EN`, and picking a region for it is a product decision
 * about which accent the guide has.
 */
const BCP47: Record<string, string> = {
  en: 'en-GB',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  nl: 'nl-NL',
  sk: 'sk-SK',
};

export function toBcp47(language: string): string {
  const code = BCP47[language];
  if (code === undefined) throw new Error(`No TTS locale mapped for language "${language}".`);
  return code;
}

export interface SynthesisSummary {
  /** Public audio URL per segment `order`. */
  audioUrlByOrder: Map<number, string>;
  /** Characters actually sent to the vendor — what you are billed for. */
  charactersBilled: number;
  /** Segments served from existing audio, costing nothing. */
  reused: number;
}

/**
 * Voices every segment of a tour, reusing anything already synthesised.
 *
 * Two levels of reuse, and the second is the economic argument of the whole
 * design:
 *
 * 1. Within a tour, identical text is synthesised once.
 * 2. ACROSS tours and travellers, because the key is a hash of what was said
 *    rather than of who asked. The body of the St Martin's segment is voiced
 *    on the first tour that includes it and reused by every tour after,
 *    forever, in that language and voice.
 */
export async function synthesizeTour(
  segments: NarrationOutput['segments'],
  args: { language: string; voice: ChirpVoice },
  deps: { tts: TtsProvider; store: AudioStore; concurrency?: number },
): Promise<SynthesisSummary> {
  const languageCode = toBcp47(args.language);
  const voice = chirpVoiceName(languageCode, args.voice);
  const concurrency = deps.concurrency ?? 4;

  // Collapse duplicates before doing any work: two segments with identical
  // text are one utterance, and paying twice for it would be a silent waste
  // that only shows up on the bill.
  const byKey = new Map<string, { text: string; orders: number[] }>();
  for (const segment of segments) {
    const key = audioKey({ text: segment.script, languageCode, voice });
    const existing = byKey.get(key);
    if (existing) existing.orders.push(segment.order);
    else byKey.set(key, { text: segment.script, orders: [segment.order] });
  }

  const audioUrlByOrder = new Map<number, string>();
  let charactersBilled = 0;
  let reused = 0;

  const entries = [...byKey.entries()];
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ([key, { text, orders }]) => {
        let url = await deps.store.find(key);

        if (url === null) {
          const result = await deps.tts.synthesize({ text, languageCode, voice });
          url = await deps.store.put(key, result.audio, result.contentType);
          charactersBilled += result.characters;
        } else {
          reused += orders.length;
        }

        for (const order of orders) audioUrlByOrder.set(order, url);
      }),
    );
  }

  return { audioUrlByOrder, charactersBilled, reused };
}
