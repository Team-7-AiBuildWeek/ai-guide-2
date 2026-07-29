import {
  NarrationOutputSchema,
  type CuratedStop,
  type GenerateRequest,
  type NarrationOutput,
  type SegmentKind,
} from '@ai-guide/shared';
import type { LlmClient, UserBlock } from '../../llm/anthropic.ts';
import type { RouteResult } from '../routing/index.ts';
import {
  narrationSystemPrompt,
  narrationStopsBlock,
  MIN_STOP_SCRIPT_CHARS,
  MAX_STOP_SCRIPT_CHARS,
  MIN_WALK_SCRIPT_CHARS,
  MAX_WALK_SCRIPT_CHARS,
} from './prompt.ts';

export { fetchStopExtracts, fetchFullText, truncateExtract, MAX_EXTRACT_CHARS } from './extracts.ts';
export { assembleTour } from './assemble.ts';
export {
  narrationSystemPrompt,
  narrationStopsBlock,
  narrationPrompt,
  MIN_STOP_SCRIPT_CHARS,
  MAX_STOP_SCRIPT_CHARS,
  MIN_WALK_SCRIPT_CHARS,
  MAX_WALK_SCRIPT_CHARS,
} from './prompt.ts';

const MAX_TOKENS = 8000;
/** Total attempts, including the first — see the module doc below. */
const MAX_ATTEMPTS = 2;

type Validated = { ok: true; output: NarrationOutput } | { ok: false; error: string };

/** The kind sequence a valid script must follow for `stopCount` stops:
 * intro, stop, walk, stop, walk, ..., stop, outro — 2*stopCount+1 entries. */
function expectedKindSequence(stopCount: number): SegmentKind[] {
  const kinds: SegmentKind[] = ['intro'];
  for (let i = 0; i < stopCount; i++) {
    kinds.push('stop');
    if (i < stopCount - 1) kinds.push('walk');
  }
  kinds.push('outro');
  return kinds;
}

function findLengthViolation(segments: NarrationOutput['segments']): string | null {
  for (const seg of segments) {
    if (seg.kind === 'stop') {
      if (seg.script.length < MIN_STOP_SCRIPT_CHARS || seg.script.length > MAX_STOP_SCRIPT_CHARS) {
        return (
          `Stop segment "${seg.title}" (order ${seg.order}) has a script ${seg.script.length} ` +
          `characters long; stop scripts must be ${MIN_STOP_SCRIPT_CHARS}-${MAX_STOP_SCRIPT_CHARS} characters.`
        );
      }
    } else if (seg.kind === 'walk') {
      if (seg.script.length < MIN_WALK_SCRIPT_CHARS || seg.script.length > MAX_WALK_SCRIPT_CHARS) {
        return (
          `Walk-cue segment "${seg.title}" (order ${seg.order}) has a script ${seg.script.length} ` +
          `characters long; walk-cue scripts must be ${MIN_WALK_SCRIPT_CHARS}-${MAX_WALK_SCRIPT_CHARS} characters.`
        );
      }
    }
  }
  return null;
}

/**
 * Parses and validates one candidate response. The Zod schema only checks
 * shape (a segment has `order`, `kind`, `title`, `script`); everything here
 * checks *truth about this specific tour*:
 *
 * 1. Exactly 2*stopCount+1 segments.
 * 2. The kind sequence, sorted by `order`, is exactly
 *    intro, stop, walk, stop, walk, ..., stop, outro.
 * 3. Every `stop` and `walk` script falls inside its length bounds — the
 *    highest-likelihood failure in the whole pipeline, because a script 3x
 *    the target length is a *plausible* one, not a JSON-shape violation.
 */
function validate(rawText: string, stopCount: number): Validated {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, error: `Response was not valid JSON: ${(err as Error).message}` };
  }

  const schemaResult = NarrationOutputSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    return { ok: false, error: `Response did not match the expected schema: ${schemaResult.error.message}` };
  }

  const byOrder = [...schemaResult.data.segments].sort((a, b) => a.order - b.order);

  const expectedCount = 2 * stopCount + 1;
  if (byOrder.length !== expectedCount) {
    return {
      ok: false,
      error: `Expected exactly ${expectedCount} segments for ${stopCount} stops (intro, stop, walk, ... stop, outro), got ${byOrder.length}.`,
    };
  }

  const expectedKinds = expectedKindSequence(stopCount);
  for (let i = 0; i < expectedKinds.length; i++) {
    if (byOrder[i].kind !== expectedKinds[i]) {
      return {
        ok: false,
        error:
          `Segment at position ${i} (order ${byOrder[i].order}) has kind "${byOrder[i].kind}", ` +
          `but the expected sequence is intro, stop, walk, stop, walk, ..., stop, outro — ` +
          `expected "${expectedKinds[i]}" at that position.`,
      };
    }
  }

  const lengthError = findLengthViolation(byOrder);
  if (lengthError !== null) return { ok: false, error: lengthError };

  return { ok: true, output: { segments: byOrder } };
}

/**
 * Writes the narration script for a curated, routed set of stops: the words
 * the traveller hears at each stop and between them.
 *
 * On a validation failure the specific error is appended to the prompt and
 * the model gets exactly ONE retry (`MAX_ATTEMPTS = 2` total attempts), then
 * `narrate` throws — the same bound curation uses, and for the same reason:
 * an unbounded retry against a paid API is how one request becomes a large
 * bill.
 */
export async function narrate(
  stops: CuratedStop[],
  extracts: Map<string, string>,
  route: RouteResult,
  request: GenerateRequest,
  deps: { llm: LlmClient },
): Promise<{ output: NarrationOutput; costUsd: number }> {
  const system = narrationSystemPrompt(request, stops.length);
  const stopsBlock: UserBlock = { text: narrationStopsBlock(stops, extracts, route), cacheable: true };

  let totalCostUsd = 0;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userBlocks: UserBlock[] =
      lastError === null
        ? [stopsBlock]
        : [
            stopsBlock,
            {
              text: `Your previous answer was invalid: ${lastError}\n\nReturn corrected JSON only, matching the same schema as before.`,
            },
          ];

    const result = await deps.llm.complete({ system, userBlocks, maxTokens: MAX_TOKENS });
    totalCostUsd += result.costUsd;

    const validated = validate(result.text, stops.length);
    if (validated.ok) {
      return { output: validated.output, costUsd: totalCostUsd };
    }

    lastError = validated.error;
  }

  throw new Error(`Narration failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`);
}
