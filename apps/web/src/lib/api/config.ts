export interface AppConfig {
  /** Mapbox public (`pk.`) token, served by the API at runtime. */
  mapboxToken: string;
}

let cached: Promise<AppConfig> | null = null;

/**
 * Fetches runtime configuration from the API, once per page load.
 *
 * The Mapbox token used to be inlined into the bundle by Vite at build time.
 * That forced it to exist in two places — a build argument AND a runtime
 * secret — and made a GitHub-triggered Fly deploy impossible without
 * committing the token, since such a build cannot receive `--build-arg`.
 * GitHub's push protection then refused the commit, unable to tell a public
 * `pk.` token from a secret `sk.` one.
 *
 * Serving it at runtime settles all of that: the token lives only in
 * `fly secrets`, never in git, and is set once rather than twice.
 *
 * It is still a public token — it reaches the browser either way, and anyone
 * can read it from the network tab. Nothing here is hiding it; the point is
 * that it is no longer in version control.
 */
export function loadConfig(
  deps: { fetch?: typeof fetch; baseUrl?: string } = {},
): Promise<AppConfig> {
  if (cached !== null) return cached;

  const doFetch = deps.fetch ?? fetch;
  const baseUrl = deps.baseUrl ?? (import.meta.env.VITE_API_BASE_URL || '');

  cached = doFetch(`${baseUrl}/api/config`).then(async (res) => {
    if (!res.ok) throw new Error(`Config request failed: ${res.status}`);
    return (await res.json()) as AppConfig;
  });

  // A failed fetch must not poison every later attempt with a rejected
  // promise nobody can retry — the map degrades gracefully, and a reload
  // should get a fresh chance.
  cached.catch(() => {
    cached = null;
  });

  return cached;
}

/** Test seam: drops the memoised config so each test starts clean. */
export function resetConfigCache(): void {
  cached = null;
}
