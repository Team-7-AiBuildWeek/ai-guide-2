import type { CassetteMode } from './types.ts';

const MODES: readonly CassetteMode[] = ['replay', 'record', 'live'];

/**
 * Resolves the cassette mode from the environment.
 *
 * Defaults to `replay` when unset, and throws on anything unrecognised. A
 * typo like CASSETTE_MODE=recrod must not silently degrade to a default —
 * whichever default it degraded to would be wrong: `replay` would look like
 * a cassette-miss bug, and anything else would spend money.
 */
export function resolveCassetteMode(
  value: string | undefined = process.env.CASSETTE_MODE,
): CassetteMode {
  if (value === undefined || value === '') return 'replay';
  if ((MODES as readonly string[]).includes(value)) return value as CassetteMode;
  throw new Error(
    `Unrecognised CASSETTE_MODE: ${JSON.stringify(value)}. Expected one of ${MODES.join(', ')}.`,
  );
}
