/**
 * One synthesised utterance: the audio bytes and what produced them.
 */
export interface SynthesisResult {
  /** Raw audio, ready to write to disk or upload to storage. */
  audio: Uint8Array;
  /** `audio/mpeg`, `audio/wav`, … — whatever the provider actually returned. */
  contentType: string;
  /** Characters billed. Providers price per character, not per token. */
  characters: number;
}

export interface SynthesisRequest {
  text: string;
  /** BCP-47, e.g. 'sk-SK', 'de-DE'. */
  languageCode: string;
  /** Provider-specific voice identifier. */
  voice: string;
  /**
   * Free-text delivery direction, e.g. "warmly, like sharing a secret".
   *
   * Chirp ignores this — its eight voices are fixed. Gemini TTS accepts it as
   * a natural-language style prompt, which is the whole reason it is worth
   * comparing: a persona like "a grumpy local historian who is tired of
   * tourists" has to be squashed into one of eight fixed voices otherwise.
   */
  style?: string;
}

/**
 * A text-to-speech vendor.
 *
 * Deliberately the same shape of seam as `LocationProvider`, `AudioPlayer` and
 * `LlmClient`: the vendor choice for voice is explicitly undecided until the
 * toponym spike runs, so nothing above this interface may depend on which one
 * wins.
 */
export interface TtsProvider {
  readonly name: string;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}
