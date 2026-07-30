// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { llmFromEnv, liveLlmClient, resolveLlmProvider } from './factory.ts';
import { AnthropicLlmClient } from './anthropic.ts';
import { GeminiLlmClient } from './gemini.ts';
import { SyntheticLlmClient } from './synthetic.ts';

const noFetch = (async () => {
  throw new Error('the factory must not call anything');
}) as unknown as typeof fetch;

describe('resolveLlmProvider', () => {
  it('defaults to gemini', () => {
    expect(resolveLlmProvider({})).toBe('gemini');
  });

  it('honours an explicit provider', () => {
    expect(resolveLlmProvider({ LLM_PROVIDER: 'anthropic' })).toBe('anthropic');
  });

  it('throws on an unrecognised provider instead of picking one', () => {
    // A typo must not silently generate tours from the wrong model — or from
    // fixtures — with nobody noticing until someone is listening on a street.
    expect(() => resolveLlmProvider({ LLM_PROVIDER: 'gemeni' })).toThrow(/gemeni/);
  });
});

describe('llmFromEnv', () => {
  it('is synthetic when LLM_MODE is unset, even with keys present', () => {
    // The default cannot spend money. Keys lying around in the environment
    // must not be enough to start billing.
    const client = llmFromEnv({ fetch: noFetch }, { GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' });
    expect(client).toBeInstanceOf(SyntheticLlmClient);
  });

  it('builds Gemini for LLM_MODE=live with no provider named', () => {
    const client = llmFromEnv({ fetch: noFetch }, { LLM_MODE: 'live', GEMINI_API_KEY: 'k' });
    expect(client).toBeInstanceOf(GeminiLlmClient);
  });

  it('builds Anthropic when asked for it', () => {
    const client = llmFromEnv(
      { fetch: noFetch },
      { LLM_MODE: 'live', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-not-real' },
    );
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });

  it('refuses to start rather than falling back to fixtures when the key is missing', () => {
    // Falling back would serve fixture tours that look completely real.
    expect(() => llmFromEnv({ fetch: noFetch }, { LLM_MODE: 'live' })).toThrow(/GEMINI_API_KEY/);
    expect(() =>
      llmFromEnv({ fetch: noFetch }, { LLM_MODE: 'live', LLM_PROVIDER: 'anthropic' }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('liveLlmClient', () => {
  it('labels the model it will actually call, so fixtures record the truth', () => {
    expect(liveLlmClient({ fetch: noFetch }, { GEMINI_API_KEY: 'k' }).label).toBe(
      'gemini-3.6-flash',
    );
    expect(
      liveLlmClient({ fetch: noFetch }, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-2.5-flash' })
        .label,
    ).toBe('gemini-2.5-flash');
    expect(
      liveLlmClient({ fetch: noFetch }, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).label,
    ).toBe('claude-opus-5');
  });

  it('always bills — it ignores LLM_MODE', () => {
    // Its callers are the recording scripts, whose entire purpose is to call
    // the real thing. Respecting LLM_MODE here would make a recording run
    // quietly re-save the fixtures it was meant to replace.
    const live = liveLlmClient({ fetch: noFetch }, { GEMINI_API_KEY: 'k' });
    expect(live.client).toBeInstanceOf(GeminiLlmClient);
  });
});
