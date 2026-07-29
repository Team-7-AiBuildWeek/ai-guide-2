import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig, resetConfigCache } from './config';

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('loadConfig', () => {
  beforeEach(() => resetConfigCache());

  it('reads the Mapbox token from the API', async () => {
    const config = await loadConfig({ fetch: fetchReturning({ mapboxToken: 'pk.test' }) });
    expect(config.mapboxToken).toBe('pk.test');
  });

  it('fetches once per page load, however many callers ask', async () => {
    const doFetch = fetchReturning({ mapboxToken: 'pk.test' });

    await Promise.all([
      loadConfig({ fetch: doFetch }),
      loadConfig({ fetch: doFetch }),
      loadConfig({ fetch: doFetch }),
    ]);

    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects on a non-OK response rather than returning a broken config', async () => {
    await expect(loadConfig({ fetch: fetchReturning({}, 500) })).rejects.toThrow(/500/);
  });

  it('does not cache a failure, so a later attempt can still succeed', async () => {
    // A rejected promise left in the cache would poison every subsequent
    // caller for the life of the page, with no way to retry.
    await expect(loadConfig({ fetch: fetchReturning({}, 500) })).rejects.toThrow();

    const config = await loadConfig({ fetch: fetchReturning({ mapboxToken: 'pk.later' }) });
    expect(config.mapboxToken).toBe('pk.later');
  });

  it('requests the config endpoint under the configured base URL', async () => {
    const doFetch = fetchReturning({ mapboxToken: 'pk.test' });
    await loadConfig({ fetch: doFetch, baseUrl: 'https://api.example.test' });
    expect(doFetch).toHaveBeenCalledWith('https://api.example.test/api/config');
  });
});
