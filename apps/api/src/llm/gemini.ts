import type { LlmClient, LlmResult, UserBlock } from './anthropic.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Per-million-token prices, input / output.
 *
 * Thinking bills at the OUTPUT rate but is reported separately as
 * `thoughtsTokenCount` — unlike Anthropic, where it is folded into
 * `output_tokens`. Counting only `candidatesTokenCount` would under-report
 * exactly the way this project's first Opus estimate did, by 70%.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-3.1-pro-preview': { input: 2.0, output: 12.0 },
  'gemini-3.6-flash': { input: 1.5, output: 7.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export function geminiCostUsd(
  model: string,
  usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number },
): number {
  const price = PRICING[model];
  if (price === undefined) {
    throw new Error(
      `No pricing for Gemini model "${model}". Add it to PRICING rather than defaulting to zero — ` +
        `a silent zero makes the daily spend cap unenforceable.`,
    );
  }
  const input = usage.promptTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return (input * price.input + output * price.output) / 1_000_000;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

/**
 * Gemini behind the same one-method seam as the Anthropic client, so curation
 * and narration cannot tell which model wrote their input.
 *
 * Built on raw `fetch` rather than `@google/genai` for one concrete reason:
 * the SDK's `HttpOptions` exposes `baseUrl` but no way to inject a `fetch`,
 * so it cannot be driven by a stub in tests or wrapped by the cassette layer.
 * The request and response shapes here were read off that SDK's own type
 * definitions, not guessed.
 */
export class GeminiLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(args: { apiKey: string; model?: string; fetch?: typeof fetch }) {
    this.apiKey = args.apiKey;
    this.model = args.model ?? DEFAULT_GEMINI_MODEL;
    this.fetchImpl = args.fetch ?? fetch;
  }

  async complete(args: {
    system: string;
    userBlocks: UserBlock[];
    maxTokens: number;
  }): Promise<LlmResult> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      // One user turn carrying every block in order. `cacheable` is ignored:
      // Gemini caches large repeated prefixes implicitly rather than taking a
      // per-block breakpoint the way Anthropic does, so there is no equivalent
      // knob to set — and pretending otherwise would hide a real difference
      // between the two providers.
      contents: [{ role: 'user', parts: args.userBlocks.map((b) => ({ text: b.text })) }],
      generationConfig: { maxOutputTokens: args.maxTokens },
    });

    // Key in a header, never the URL — see the Chirp provider for why: a URL
    // travels into errors, logs and cassette keys, and a key went with it once.
    const res = await this.fetchImpl(`${ENDPOINT}/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini request failed: ${res.status} ${detail.slice(0, 1200)}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];

    // Truncation must announce itself. Left alone it surfaces downstream as
    // "Response was not valid JSON: Unterminated string", which points at the
    // parser rather than the cap — a misdirection that cost two paid attempts
    // on the Anthropic path.
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error(
        `Response hit maxTokens (${args.maxTokens}) and was truncated. maxTokens caps ` +
          `thinking AND output together, and thinking can take most of it — raise the cap. ` +
          `It is a ceiling, not a reservation: billing follows tokens actually generated.`,
      );
    }

    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (text === '') {
      throw new Error(
        `Gemini returned no text (finishReason: ${candidate?.finishReason ?? 'none'}).`,
      );
    }

    return { text, costUsd: geminiCostUsd(this.model, data.usageMetadata ?? {}) };
  }
}
