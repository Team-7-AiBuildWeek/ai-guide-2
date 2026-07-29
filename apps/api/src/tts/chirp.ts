import type { SynthesisRequest, SynthesisResult, TtsProvider } from './types.ts';

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/**
 * The eight Chirp 3 HD voices, shared across every language.
 *
 * That sharing is the point: a persona keeps its identity across the whole
 * catalogue, so "the grumpy historian" sounds like the same person in Slovak
 * and in German. It is also the limitation — eight fixed voices, no delivery
 * direction, which is what makes Gemini TTS worth comparing.
 */
export const CHIRP_VOICES = [
  'Aoede',
  'Charon',
  'Fenrir',
  'Kore',
  'Leda',
  'Orus',
  'Puck',
  'Zephyr',
] as const;

export type ChirpVoice = (typeof CHIRP_VOICES)[number];

/** Chirp voice names are `<languageCode>-Chirp3-HD-<Voice>`. */
export function chirpVoiceName(languageCode: string, voice: ChirpVoice): string {
  return `${languageCode}-Chirp3-HD-${voice}`;
}

export class ChirpTtsProvider implements TtsProvider {
  readonly name = 'chirp3hd';

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(args: { apiKey: string; fetch?: typeof fetch }) {
    this.apiKey = args.apiKey;
    this.fetchImpl = args.fetch ?? fetch;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    // `style` is deliberately ignored: Chirp has no delivery-direction
    // parameter. Silently dropping it would make the two providers look
    // interchangeable in the spike when they are not.
    const body = JSON.stringify({
      input: { text: request.text },
      voice: { languageCode: request.languageCode, name: request.voice },
      audioConfig: { audioEncoding: 'MP3' },
    });

    const res = await this.fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      // Never include the URL: the API key is a query parameter, and this
      // message reaches logs and the job row.
      const detail = await res.text().catch(() => '');
      throw new Error(`Chirp synthesis failed: ${res.status} ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as { audioContent?: string };
    if (!data.audioContent) {
      throw new Error('Chirp returned no audioContent.');
    }

    return {
      audio: Uint8Array.from(Buffer.from(data.audioContent, 'base64')),
      contentType: 'audio/mpeg',
      characters: request.text.length,
    };
  }
}
