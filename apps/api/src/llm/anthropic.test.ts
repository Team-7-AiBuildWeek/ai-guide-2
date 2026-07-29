// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { buildMessageParams, AnthropicLlmClient } from './anthropic.ts';

describe('buildMessageParams', () => {
  it('targets claude-opus-5', () => {
    const params = buildMessageParams({ system: 'sys', userBlocks: [{ text: 'hi' }], maxTokens: 100 });
    expect(params.model).toBe('claude-opus-5');
  });

  it('uses adaptive thinking, never the budget_tokens form', () => {
    const params = buildMessageParams({ system: 'sys', userBlocks: [{ text: 'hi' }], maxTokens: 100 });
    expect(params.thinking).toEqual({ type: 'adaptive' });
    // budget_tokens belongs to the `enabled` variant; sending it alongside
    // `type: 'adaptive'` is exactly the shape that returns a 400 on Opus 5.
    expect(params.thinking).not.toHaveProperty('budget_tokens');
  });

  it('forwards maxTokens as max_tokens', () => {
    const params = buildMessageParams({ system: 'sys', userBlocks: [{ text: 'hi' }], maxTokens: 4096 });
    expect(params.max_tokens).toBe(4096);
  });

  it('passes the system prompt through verbatim', () => {
    const params = buildMessageParams({
      system: 'You are selecting stops for a walking tour.',
      userBlocks: [{ text: 'hi' }],
      maxTokens: 100,
    });
    expect(params.system).toBe('You are selecting stops for a walking tour.');
  });

  it('marks cacheable blocks with an ephemeral cache_control breakpoint', () => {
    const params = buildMessageParams({
      system: 'sys',
      userBlocks: [
        { text: 'candidate list', cacheable: true },
        { text: 'per-request instructions' },
      ],
      maxTokens: 100,
    });
    const content = params.messages[0].content as { type: string; text: string; cache_control?: unknown }[];
    expect(content[0]).toMatchObject({ text: 'candidate list', cache_control: { type: 'ephemeral' } });
    expect(content[1]).toMatchObject({ text: 'per-request instructions' });
    expect(content[1].cache_control).toBeUndefined();
  });

  it('builds a single user message carrying every block in order', () => {
    const params = buildMessageParams({
      system: 'sys',
      userBlocks: [{ text: 'first' }, { text: 'second' }],
      maxTokens: 100,
    });
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe('user');
    const content = params.messages[0].content as { text: string }[];
    expect(content.map((b) => b.text)).toEqual(['first', 'second']);
  });
});

/** Encodes one SSE frame exactly as the SDK's line decoder expects it. */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Builds a fake `fetch` that never touches the network: it returns a
 * synthetic Server-Sent-Events response built entirely in-process, so
 * `AnthropicLlmClient` can be exercised end-to-end (request shape in,
 * `finalMessage()` parsing out) without an Anthropic API call.
 */
function fakeStreamingFetch(
  replyText: string,
  usage: { inputTokens: number; outputTokens: number; thinkingTokens?: number },
  stopReason: 'end_turn' | 'max_tokens' = 'end_turn',
) {
  const frames = [
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        container: null,
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
        },
      },
    }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: replyText },
    }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: usage.outputTokens,
        output_tokens_details:
          usage.thinkingTokens === undefined
            ? null
            : { thinking_tokens: usage.thinkingTokens },
      },
    }),
    sseFrame('message_stop', { type: 'message_stop' }),
  ];

  const body = frames.join('');
  const calls: { url: string; init: Parameters<typeof fetch>[1] }[] = [];

  const fetchStub = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  return { fetchStub: fetchStub as unknown as typeof fetch, calls };
}

describe('AnthropicLlmClient', () => {
  it('parses the streamed text and computes cost from billed usage, without any real network call', async () => {
    const { fetchStub, calls } = fakeStreamingFetch('{"tourTitle":"Test Tour","stops":[]}', {
      inputTokens: 1000,
      outputTokens: 2000,
    });
    const client = new AnthropicLlmClient({ apiKey: 'sk-fake-not-a-real-key', fetch: fetchStub });

    const result = await client.complete({
      system: 'sys',
      userBlocks: [{ text: 'candidates', cacheable: true }],
      maxTokens: 8000,
    });

    expect(result.text).toBe('{"tourTitle":"Test Tour","stops":[]}');
    expect(result.costUsd).toBeCloseTo(1000 * (5 / 1_000_000) + 2000 * (25 / 1_000_000), 10);

    // Exactly one HTTP attempt, and it never left this process: `fetchStub`
    // is a local function returning an in-memory Response, so nothing here
    // can have reached api.anthropic.com regardless of what URL it recorded.
    expect(calls).toHaveLength(1);
    const requestBody = JSON.parse(calls[0].init?.body as string);
    expect(requestBody.model).toBe('claude-opus-5');
    expect(requestBody.thinking).toEqual({ type: 'adaptive' });
    expect(requestBody.stream).toBe(true);
  });
});

describe('AnthropicLlmClient — truncated responses', () => {
  // The first live run of this pipeline burned two paid attempts on a
  // response truncated by max_tokens, because it surfaced downstream as
  // "Response was not valid JSON: Unterminated string at position 1897".
  // That message points at the parser; the actual cause was the cap. Real
  // numbers from that run: 8000-token budget, 7182 spent on thinking.
  it('throws naming the cap rather than returning truncated text', async () => {
    const { fetchStub } = fakeStreamingFetch(
      '{"tourTitle":"Truncated","stops":[{"title":"Mich',
      { inputTokens: 17_000, outputTokens: 8000, thinkingTokens: 7182 },
      'max_tokens',
    );
    const client = new AnthropicLlmClient({ apiKey: 'sk-fake-not-a-real-key', fetch: fetchStub });

    await expect(
      client.complete({ system: 'sys', userBlocks: [{ text: 'x' }], maxTokens: 8000 }),
    ).rejects.toThrow(/maxTokens/i);
  });

  it('explains that thinking shares the cap, and never quotes a bogus zero', async () => {
    // The SDK does not merge output_tokens_details into the final message, so
    // any thinking-token count read here would be 0 even when thinking ate
    // the budget. The message must therefore describe the mechanism rather
    // than report a number that would be actively misleading.
    const { fetchStub } = fakeStreamingFetch(
      '{"partial',
      { inputTokens: 100, outputTokens: 8000, thinkingTokens: 7182 },
      'max_tokens',
    );
    const client = new AnthropicLlmClient({ apiKey: 'sk-fake-not-a-real-key', fetch: fetchStub });

    const err = await client
      .complete({ system: 'sys', userBlocks: [{ text: 'x' }], maxTokens: 8000 })
      .then(() => null, (e: Error) => e);

    expect(err?.message).toMatch(/thinking AND output together/i);
    expect(err?.message).not.toMatch(/0 were thinking/);
  });

  it('still returns normally when the model stopped of its own accord', async () => {
    const { fetchStub } = fakeStreamingFetch('{"ok":true}', {
      inputTokens: 10,
      outputTokens: 20,
      thinkingTokens: 5,
    });
    const client = new AnthropicLlmClient({ apiKey: 'sk-fake-not-a-real-key', fetch: fetchStub });

    const res = await client.complete({ system: 's', userBlocks: [{ text: 'x' }], maxTokens: 8000 });
    expect(res.text).toBe('{"ok":true}');
  });
});
