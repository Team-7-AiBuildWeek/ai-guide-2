/**
 * Per-model USD pricing, per input/output token. Extend this table when a
 * new model is wired in; do not add a fallback price — see `costUsd` below.
 */
const PRICING = {
  'claude-opus-5': { input: 5 / 1_000_000, output: 25 / 1_000_000 },
} as const;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Measures the USD cost of one completion from its billed usage. Never an
 * estimate: `output_tokens` already includes thinking tokens, and omitting
 * them is exactly why this project's first cost estimate was ~25% low.
 *
 * Throws on an unknown model rather than returning 0 — a silent zero would
 * make the daily spend cap unenforceable, which is the one control standing
 * between a retry loop and a large bill.
 */
export function costUsd(model: string, usage: Usage): number {
  const pricing = PRICING[model as keyof typeof PRICING];
  if (pricing === undefined) throw new Error(`No pricing for model ${model}`);
  return usage.input_tokens * pricing.input + usage.output_tokens * pricing.output;
}
