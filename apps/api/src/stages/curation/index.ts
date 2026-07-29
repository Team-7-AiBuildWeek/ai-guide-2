import {
  CurationOutputSchema,
  haversineM,
  type CurationOutput,
  type CuratedStop,
  type GenerateRequest,
  type Poi,
} from '@ai-guide/shared';
import type { LlmClient, UserBlock } from '../../llm/anthropic.ts';
import { curationSystemPrompt, curationCandidateBlock } from './prompt.ts';

const MAX_TOKENS = 8000;
const MIN_STOP_SEPARATION_M = 100;
/** Total attempts, including the first — see the module doc below. */
const MAX_ATTEMPTS = 2;

type Validated = { ok: true; output: CurationOutput } | { ok: false; error: string };

/**
 * Parses and validates one candidate response. The Zod schema only checks
 * shape (8–12 stops, well-formed QIDs, required fields); everything here
 * checks *truth against the input*:
 *
 * 1. Every QID the model returned must exist in the candidate set it was
 *    given. This is the anti-hallucination guard — Opus cannot invent a
 *    palace, because anything not in `pois` is rejected outright.
 * 2. Consecutive stops (by `order`) must be at least `MIN_STOP_SEPARATION_M`
 *    apart, computed with `haversineM` — the same distance function the
 *    trigger engine uses, so "far enough apart to trigger independently"
 *    means the same thing here as it does at runtime.
 */
function validate(rawText: string, validQids: ReadonlySet<string>): Validated {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, error: `Response was not valid JSON: ${(err as Error).message}` };
  }

  const schemaResult = CurationOutputSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    return { ok: false, error: `Response did not match the expected schema: ${schemaResult.error.message}` };
  }
  const output = schemaResult.data;

  for (const stop of output.stops) {
    for (const qid of stop.wikidataQids) {
      if (!validQids.has(qid)) {
        return {
          ok: false,
          error: `Unknown wikidataQid "${qid}" in stop "${stop.title}" — it is not in the candidate set given to the model. Every QID must come from the supplied candidates; inventing one is not allowed.`,
        };
      }
    }
  }

  const separationError = findSeparationViolation(output.stops);
  if (separationError !== null) return { ok: false, error: separationError };

  return { ok: true, output };
}

function findSeparationViolation(stops: CuratedStop[]): string | null {
  const byOrder = [...stops].sort((a, b) => a.order - b.order);
  for (let i = 1; i < byOrder.length; i++) {
    const prev = byOrder[i - 1];
    const curr = byOrder[i];
    const distanceM = haversineM(prev.standingPoint, curr.standingPoint);
    if (distanceM < MIN_STOP_SEPARATION_M) {
      return (
        `Stops "${prev.title}" (order ${prev.order}) and "${curr.title}" (order ${curr.order}) ` +
        `are only ${distanceM.toFixed(1)}m apart; consecutive stops must be at least ${MIN_STOP_SEPARATION_M}m apart.`
      );
    }
  }
  return null;
}

/**
 * Picks 8–12 ordered walking-tour stops from the candidate POIs.
 *
 * On a validation failure the specific error is appended to the prompt and
 * the model gets exactly ONE retry (`MAX_ATTEMPTS = 2` total attempts), then
 * `curate` throws. This is a hard bound, not a loop: an unbounded retry
 * against a paid API is the second way (after a silent cost-zero, see
 * `llm/cost.ts`) this pipeline could turn one request into a large bill.
 */
export async function curate(
  pois: Poi[],
  request: GenerateRequest,
  deps: { llm: LlmClient },
): Promise<{ output: CurationOutput; costUsd: number }> {
  const system = curationSystemPrompt(request);
  const candidateBlock: UserBlock = { text: curationCandidateBlock(pois), cacheable: true };
  const validQids = new Set(pois.map((p) => p.wikidataQid));

  let totalCostUsd = 0;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userBlocks: UserBlock[] =
      lastError === null
        ? [candidateBlock]
        : [
            candidateBlock,
            {
              text: `Your previous answer was invalid: ${lastError}\n\nReturn corrected JSON only, matching the same schema as before.`,
            },
          ];

    const result = await deps.llm.complete({ system, userBlocks, maxTokens: MAX_TOKENS });
    totalCostUsd += result.costUsd;

    const validated = validate(result.text, validQids);
    if (validated.ok) {
      return { output: validated.output, costUsd: totalCostUsd };
    }

    lastError = validated.error;
  }

  throw new Error(`Curation failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`);
}
