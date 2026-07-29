import Anthropic from '@anthropic-ai/sdk';
import { costUsd } from './cost.ts';

export interface LlmResult {
  text: string;
  costUsd: number;
}

/**
 * One user-turn content block. `cacheable` blocks get an ephemeral
 * `cache_control` breakpoint — meant for text that is byte-identical across
 * calls (e.g. the ~150-candidate POI list), where cached reads run ~90%
 * cheaper than a fresh read.
 */
export interface UserBlock {
  text: string;
  cacheable?: boolean;
}

/**
 * The one method every downstream stage depends on, so tests can stub it
 * without touching the SDK, a network socket, or a cassette.
 */
export interface LlmClient {
  complete(args: { system: string; userBlocks: UserBlock[]; maxTokens: number }): Promise<LlmResult>;
}

const MODEL: Anthropic.Model = 'claude-opus-5';

/**
 * Builds the request body `messages.stream()` sends. Pulled out as a pure
 * function so its shape — model, thinking mode, cache_control placement — is
 * testable without a network call or a hand-rolled SSE fixture.
 */
export function buildMessageParams(args: {
  system: string;
  userBlocks: UserBlock[];
  maxTokens: number;
}): Anthropic.MessageStreamParams {
  const content: Anthropic.TextBlockParam[] = args.userBlocks.map((block) => ({
    type: 'text',
    text: block.text,
    // `cache_control: undefined` and an omitted key are equivalent on the
    // wire, but explicit `undefined` keeps every block the same shape.
    ...(block.cacheable ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  return {
    model: MODEL,
    max_tokens: args.maxTokens,
    system: args.system,
    // Adaptive thinking only: `budget_tokens` (the `enabled` variant) is
    // rejected with a 400 on this model.
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content }],
  };
}

function isTextBlock(block: Anthropic.ContentBlock): block is Anthropic.TextBlock {
  return block.type === 'text';
}

/**
 * Thin wrapper around `@anthropic-ai/sdk`. Accepts an injected `fetch` so the
 * cassette layer (`apps/api/src/cassette`) can wrap every outbound call the
 * same way it wraps discovery's plain `fetch` calls; the SDK never sees the
 * live network directly in a test or a replay run.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(deps: { apiKey: string; fetch: typeof fetch }) {
    this.client = new Anthropic({ apiKey: deps.apiKey, fetch: deps.fetch });
  }

  async complete(args: {
    system: string;
    userBlocks: UserBlock[];
    maxTokens: number;
  }): Promise<LlmResult> {
    const params = buildMessageParams(args);
    const stream = this.client.messages.stream(params);
    const message = await stream.finalMessage();

    const text = message.content.filter(isTextBlock).map((block) => block.text).join('');

    return {
      text,
      costUsd: costUsd(message.model, {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      }),
    };
  }
}
