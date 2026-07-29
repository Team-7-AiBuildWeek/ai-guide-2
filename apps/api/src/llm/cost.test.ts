import { describe, it, expect } from 'vitest';
import { costUsd } from './cost.ts';

describe('costUsd', () => {
  it('prices input and output tokens separately for claude-opus-5', () => {
    const cost = costUsd('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(5 + 25, 6);
  });

  it('includes thinking tokens, because they are already folded into output_tokens', () => {
    // A response with a large thinking budget: output_tokens covers both the
    // visible reply and the thinking that produced it. costUsd must not
    // require (or accept) a separate thinking-token field — undercounting
    // this is exactly how the project's first estimate ran ~25% low.
    const withThinking = costUsd('claude-opus-5', { input_tokens: 1000, output_tokens: 5000 });
    const withoutThinking = costUsd('claude-opus-5', { input_tokens: 1000, output_tokens: 500 });
    expect(withThinking).toBeGreaterThan(withoutThinking);
    expect(withThinking).toBeCloseTo(1000 * (5 / 1_000_000) + 5000 * (25 / 1_000_000), 10);
  });

  it('returns 0 for a request with no tokens', () => {
    expect(costUsd('claude-opus-5', { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });

  it('throws on an unknown model rather than returning 0', () => {
    // A silent zero would make the daily spend cap unenforceable.
    expect(() => costUsd('claude-sonnet-4', { input_tokens: 100, output_tokens: 100 })).toThrow(
      /No pricing for model claude-sonnet-4/,
    );
  });
});
