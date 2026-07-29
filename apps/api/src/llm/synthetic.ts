import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmClient, LlmResult, UserBlock } from './anthropic.ts';

const here = dirname(fileURLToPath(import.meta.url));
const syntheticDir = join(here, '..', '..', 'cassettes', 'synthetic');

/**
 * Serves the hand-authored curation and narration fixtures instead of calling
 * a paid API, so the whole generate flow — form, SSE progress, assembled tour,
 * player — can be exercised end to end at zero cost.
 *
 * This exists because "all the tests pass" and "you can run the app" are
 * different claims. The tests stub `LlmClient` directly; the service builds a
 * real `AnthropicLlmClient`. Without this, a local `npm run dev:api` in the
 * default replay mode dies at the curation stage with a cassette miss, since
 * the synthetic fixtures are parsed model *outputs*, not recorded HTTP
 * exchanges the cassette layer could replay.
 *
 * What it does NOT do is tell you anything about how Opus 5 actually behaves.
 * These fixtures were written to satisfy the validators they are checked
 * against, which is circular by construction. Only a real recording run
 * (CASSETTE_MODE=record with a key) tests the prompts.
 */
export class SyntheticLlmClient implements LlmClient {
  async complete(args: {
    system: string;
    userBlocks: UserBlock[];
    maxTokens: number;
  }): Promise<LlmResult> {
    const prompt = `${args.system}\n${args.userBlocks.map((b) => b.text).join('\n')}`;
    const stage = detectStage(prompt);

    const file =
      stage === 'curation' ? 'curation-bratislava.json' : 'narration-bratislava-sk.json';
    const raw = JSON.parse(await readFile(join(syntheticDir, file), 'utf8')) as Record<
      string,
      unknown
    >;

    // Strip the bookkeeping keys so the payload matches what a model would
    // actually return, and the same validators run against it unchanged.
    const { _synthetic, _comment, ...payload } = raw;
    void _synthetic;
    void _comment;

    // Zero, not an estimate. Nothing was spent, and the daily spend cap must
    // not be nudged toward its limit by calls that never cost anything.
    return { text: JSON.stringify(payload), costUsd: 0 };
  }
}

function detectStage(prompt: string): 'curation' | 'narration' {
  // The curation prompt asks for stops to be selected; the narration prompt
  // asks for segments to be written. Matching on the output contract rather
  // than on prose keeps this stable if the wording is edited.
  if (/"?stops"?\s*:/.test(prompt) || /select\s+8-12\s+stops/i.test(prompt)) return 'curation';
  return 'narration';
}
