// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { GeminiLlmClient, geminiCostUsd, DEFAULT_GEMINI_MODEL } from './gemini.ts';

function reply(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

const ok = {
  candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 2000, thoughtsTokenCount: 500 },
};

describe('geminiCostUsd', () => {
  it('bills thinking at the output rate, not for free', () => {
    // Gemini reports thoughtsTokenCount SEPARATELY from candidatesTokenCount,
    // unlike Anthropic where thinking is folded into output_tokens. Counting
    // only candidates would under-report exactly the way this project's first
    // Opus estimate did.
    const withThinking = geminiCostUsd('gemini-3.6-flash', {
      promptTokenCount: 0,
      candidatesTokenCount: 1000,
      thoughtsTokenCount: 1000,
    });
    const without = geminiCostUsd('gemini-3.6-flash', {
      promptTokenCount: 0,
      candidatesTokenCount: 1000,
      thoughtsTokenCount: 0,
    });
    expect(withThinking).toBeCloseTo(without * 2, 10);
  });

  it('prices input and output at their separate rates', () => {
    // gemini-3.6-flash: $1.50 in, $7.50 out per 1M.
    const cost = geminiCostUsd('gemini-3.6-flash', {
      promptTokenCount: 1_000_000,
      candidatesTokenCount: 1_000_000,
      thoughtsTokenCount: 0,
    });
    expect(cost).toBeCloseTo(9.0, 6);
  });

  it('throws on an unknown model rather than returning zero', () => {
    // A silent zero makes the daily spend cap unenforceable, which is the one
    // control standing between a retry loop and a large bill.
    expect(() => geminiCostUsd('gemini-not-a-model', { candidatesTokenCount: 1 })).toThrow(
      /no pricing/i,
    );
  });

  it('treats missing counts as zero rather than NaN', () => {
    expect(geminiCostUsd(DEFAULT_GEMINI_MODEL, {})).toBe(0);
  });
});

describe('GeminiLlmClient', () => {
  it('returns the model text and a measured cost', async () => {
    const client = new GeminiLlmClient({ apiKey: 'test-key', fetch: reply(ok) });
    const result = await client.complete({
      system: 'sys',
      userBlocks: [{ text: 'candidates', cacheable: true }],
      maxTokens: 32_000,
    });

    expect(result.text).toBe('{"ok":true}');
    expect(result.costUsd).toBeCloseTo(
      (1000 * 1.5 + 2500 * 7.5) / 1_000_000,
      10,
    );
  });

  it('sends the key in a header, never in the URL', async () => {
    // A URL travels into errors, logs, cassette keys and filenames. A Google
    // key reached a log through a query parameter once in this project.
    const doFetch = reply(ok);
    const client = new GeminiLlmClient({ apiKey: 'super-secret', fetch: doFetch });
    await client.complete({ system: 's', userBlocks: [{ text: 'x' }], maxTokens: 100 });

    const [url, init] = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).not.toContain('super-secret');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'super-secret' });
  });

  it('puts the system prompt in systemInstruction and blocks in one user turn', async () => {
    const doFetch = reply(ok);
    const client = new GeminiLlmClient({ apiKey: 'k', fetch: doFetch });
    await client.complete({
      system: 'you are selecting stops',
      userBlocks: [{ text: 'first' }, { text: 'second' }],
      maxTokens: 4096,
    });

    const [, init] = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.systemInstruction.parts[0].text).toBe('you are selecting stops');
    expect(sent.contents).toHaveLength(1);
    expect(sent.contents[0].parts.map((p: { text: string }) => p.text)).toEqual(['first', 'second']);
    expect(sent.generationConfig.maxOutputTokens).toBe(4096);
  });

  it('targets the configured model, defaulting sensibly', async () => {
    const doFetch = reply(ok);
    await new GeminiLlmClient({ apiKey: 'k', fetch: doFetch }).complete({
      system: 's',
      userBlocks: [{ text: 'x' }],
      maxTokens: 100,
    });
    expect(String((doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
      DEFAULT_GEMINI_MODEL,
    );
  });

  it('throws naming the cap when the response was truncated', async () => {
    // Otherwise this surfaces downstream as "Response was not valid JSON:
    // Unterminated string", pointing at the parser instead of the cap — the
    // misdirection that cost two paid attempts on the Anthropic path.
    const truncated = {
      candidates: [{ content: { parts: [{ text: '{"partial' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8000, thoughtsTokenCount: 7000 },
    };
    const client = new GeminiLlmClient({ apiKey: 'k', fetch: reply(truncated) });

    await expect(
      client.complete({ system: 's', userBlocks: [{ text: 'x' }], maxTokens: 8000 }),
    ).rejects.toThrow(/maxTokens.*truncated/is);
  });

  it('explains that thinking shares the cap', async () => {
    const truncated = {
      candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }],
    };
    const client = new GeminiLlmClient({ apiKey: 'k', fetch: reply(truncated) });
    const err = await client
      .complete({ system: 's', userBlocks: [{ text: 'x' }], maxTokens: 8000 })
      .then(() => null, (e: Error) => e);

    expect(err?.message).toMatch(/thinking AND output together/i);
  });

  it('fails loudly on an empty response rather than returning nothing', async () => {
    const empty = { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] };
    const client = new GeminiLlmClient({ apiKey: 'k', fetch: reply(empty) });

    await expect(
      client.complete({ system: 's', userBlocks: [{ text: 'x' }], maxTokens: 100 }),
    ).rejects.toThrow(/no text.*SAFETY/is);
  });

  it('surfaces an HTTP failure with enough detail to act on', async () => {
    const client = new GeminiLlmClient({
      apiKey: 'k',
      fetch: reply({ error: { message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 429),
    });

    await expect(
      client.complete({ system: 's', userBlocks: [{ text: 'x' }], maxTokens: 100 }),
    ).rejects.toThrow(/429.*RESOURCE_EXHAUSTED/is);
  });
});
