import { createHash } from 'node:crypto';
import type { CassetteMode, CassetteStore } from './types.ts';

export function cassetteKey(method: string, url: string, body?: string): string {
  const base = `${method.toUpperCase()} ${url}`;
  if (body === undefined || body === '') return base;
  return `${base} ${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
}

/**
 * Wraps `fetch` with record/replay behaviour.
 *
 * In `replay` a cassette miss THROWS. It must never fall through to a live
 * call: a fallback would fail open, in the direction of money, silently —
 * which is how an unattended test run becomes a large bill. This is the one
 * error in the system that is deliberately not recoverable at runtime.
 */
export function cassetteFetch(
  mode: CassetteMode,
  store: CassetteStore,
  live: typeof fetch = fetch,
): typeof fetch {
  // Derived from `fetch` itself rather than naming DOM types: this workspace
  // compiles without the DOM lib, and Node supplies its own fetch typings.
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const key = cassetteKey(method, url, body);

    if (mode === 'replay') {
      const hit = await store.get(key);
      if (hit === null) {
        throw new Error(
          `Cassette miss: ${key}\nRun with CASSETTE_MODE=record to record it.`,
        );
      }
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    }

    const res = await live(input, init);

    if (mode === 'record') {
      // clone() matters: reading the body consumes the stream, so recording
      // from the original response would hand the caller a drained one.
      const text = await res.clone().text();
      await store.put(key, {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: text,
      });
    }

    return res;
  }) as typeof fetch;
}
