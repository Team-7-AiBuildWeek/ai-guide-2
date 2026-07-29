/**
 * Retry wrapper for the discovery stage's outbound calls.
 *
 * Wikidata's public SPARQL endpoint returns a 502 on a normal, healthy
 * fraction of requests — that is measured behaviour, not a sign the query is
 * wrong (see task-5-brief.md). A transient 5xx or a network-level failure is
 * worth retrying with backoff; a 4xx means the request itself is malformed
 * and retrying it will only reproduce the same failure three times slower.
 */

export interface RetryOptions {
  /** Total attempts, including the first. Defaults to 3. */
  retries?: number;
  /** Base delay for exponential backoff (doubles each retry). Defaults to 300ms. */
  baseDelayMs?: number;
  /** Injectable so tests don't pay real wall-clock backoff time. */
  wait?: (ms: number) => Promise<void>;
}

const realWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls `fetchFn(input, init)`, retrying on 5xx responses, on 429 (rate
 * limited — Wikimedia's APIs use this to mean "slow down", not "your
 * request is malformed"), and on thrown (network-level) errors, up to
 * `retries` attempts total with exponential backoff between attempts. Any
 * other 4xx response is returned as a thrown error immediately, without
 * retrying — see module doc.
 */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
  options: RetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const wait = options.wait ?? realWait;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(input, init);
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
      await wait(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }

    if (res.status >= 500 || res.status === 429) {
      lastError = new Error(`HTTP ${res.status} (retryable) from ${describe(input)}`);
      if (attempt === retries) throw lastError;
      await wait(retryDelayMs(res, baseDelayMs, attempt));
      continue;
    }

    if (!res.ok) {
      // Any other 4xx: the request itself is the problem. Retrying would not help.
      throw new Error(`HTTP ${res.status} (client error) from ${describe(input)}`);
    }

    return res;
  }

  // Unreachable given retries >= 1, but keeps the return type sound.
  throw lastError ?? new Error('fetchWithRetry: exhausted retries with no recorded error');
}

/** Honours a numeric `Retry-After` (seconds) if the server sent one; otherwise exponential backoff. */
function retryDelayMs(res: Response, baseDelayMs: number, attempt: number): number {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return baseDelayMs * 2 ** (attempt - 1);
}

function describe(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
