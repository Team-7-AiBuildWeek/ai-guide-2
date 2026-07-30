import type { LlmClient } from './anthropic.ts';
import { AnthropicLlmClient } from './anthropic.ts';
import { GeminiLlmClient, DEFAULT_GEMINI_MODEL } from './gemini.ts';
import { SyntheticLlmClient } from './synthetic.ts';

/**
 * A live client plus the model name it will actually call.
 *
 * The label exists because recorded fixtures carry a `_comment` saying which
 * model produced them, and that line is the only thing distinguishing a
 * hand-authored fixture from real output six months later. Hardcoding
 * "claude-opus-5" in the recording script would have quietly started lying
 * the moment the provider became configurable.
 */
export interface LiveLlm {
  client: LlmClient;
  label: string;
}

export type LlmProvider = 'gemini' | 'anthropic';

/**
 * Gemini by default.
 *
 * A cold tour on Opus 5 measured $0.79, essentially all of it output tokens
 * (curation $0.35 + narration $0.44), and Gemini prices output roughly 3.3x
 * lower. Both sit behind the identical one-method `LlmClient` seam, so
 * `LLM_PROVIDER=anthropic` goes back with one variable rather than a revert —
 * which matters, because we have one measured quality data point (Opus, good)
 * and none yet for Gemini.
 */
export function resolveLlmProvider(env: Record<string, string | undefined> = process.env): LlmProvider {
  const raw = env.LLM_PROVIDER ?? 'gemini';
  if (raw === 'gemini' || raw === 'anthropic') return raw;
  // Not a fall back to the default, and not to synthetic: a typo'd provider
  // name would otherwise silently produce a tour from the wrong model — or
  // from fixtures — and nobody would notice until someone was standing on a
  // street listening to it.
  throw new Error(
    `Unknown LLM_PROVIDER "${raw}". Expected "gemini" or "anthropic". Refusing to start.`,
  );
}

/**
 * Builds a client that calls a real, paid model. Callers that should respect
 * the synthetic default want `llmFromEnv` instead — this one always bills.
 */
export function liveLlmClient(
  deps: { fetch: typeof fetch },
  env: Record<string, string | undefined> = process.env,
): LiveLlm {
  const provider = resolveLlmProvider(env);

  if (provider === 'gemini') {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('LLM_PROVIDER=gemini requires GEMINI_API_KEY. Refusing to start.');
    }
    const model = env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    return { client: new GeminiLlmClient({ apiKey, model, fetch: deps.fetch }), label: model };
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Refusing to start.');
  }
  return { client: new AnthropicLlmClient({ apiKey, fetch: deps.fetch }), label: 'claude-opus-5' };
}

/**
 * Synthetic unless explicitly told otherwise.
 *
 * The default is the one that cannot spend money: an operator who has not
 * said "use the real model" gets the hand-authored fixtures, so a plain
 * `npm run dev:api` is free. `LLM_MODE=live` opts in, and then a missing key
 * is a startup failure rather than a silent downgrade — a downgrade would
 * serve fixture tours that look real.
 */
export function llmFromEnv(
  deps: { fetch: typeof fetch },
  env: Record<string, string | undefined> = process.env,
): LlmClient {
  if (env.LLM_MODE !== 'live') return new SyntheticLlmClient();
  return liveLlmClient(deps, env).client;
}
