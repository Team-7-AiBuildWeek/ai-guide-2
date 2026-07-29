import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { TourRepository } from './db/repository.ts';

const DEFAULT_DAILY_SPEND_CAP_USD = 5;

/**
 * Constant-time string comparison. `===` short-circuits on the first
 * mismatched byte, which leaks how many leading characters of a guess were
 * correct through response timing; `timingSafeEqual` does not, but it
 * throws if the two buffers aren't the same length, so unequal-length
 * inputs are rejected up front rather than passed in.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Builds the middleware that guards `POST /api/tours`: a passphrase, then a
 * hard daily spend cap in front of a paid Anthropic API key.
 *
 * Reads `GENERATE_PASSPHRASE` once, at construction time, and **throws if it
 * is unset** rather than defaulting to open. A public endpoint with a paid
 * API key behind it that silently accepts every request because an env var
 * was missing is exactly the accident this exists to prevent — so the app
 * must refuse to even start, not start open.
 */
export function createGenerateAuthMiddleware(deps: {
  repo: TourRepository;
  env?: NodeJS.ProcessEnv;
}): MiddlewareHandler {
  const env = deps.env ?? process.env;
  const passphrase = env.GENERATE_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      'GENERATE_PASSPHRASE is not set. Refusing to start rather than defaulting to open — ' +
        'this endpoint sits in front of a paid API key.',
    );
  }

  const capUsd = Number(env.DAILY_SPEND_CAP_USD ?? String(DEFAULT_DAILY_SPEND_CAP_USD));

  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;

    if (!safeEqual(provided, passphrase)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const spentTodayUsd = await deps.repo.spendTodayUsd();
    if (spentTodayUsd >= capUsd) {
      return c.json(
        {
          error: `Daily spend cap of $${capUsd.toFixed(2)} reached (spent $${spentTodayUsd.toFixed(2)} today). Try again tomorrow.`,
        },
        429,
      );
    }

    await next();
  };
}
