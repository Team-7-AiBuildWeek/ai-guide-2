import type { CuratedStop, LineString } from '@ai-guide/shared';
import type { CassetteMode, CassetteStore } from '../../cassette/index.ts';
import { cassetteFetch } from '../../cassette/index.ts';
import { fetchWithRetry } from '../discovery/retry.ts';

/**
 * Mapbox Directions rejects a request over this many waypoints. 8-12 curated
 * stops never gets close, but a silent truncation or a confusing upstream
 * error is worse than failing here with a clear message.
 */
export const MAX_WAYPOINTS = 25;

const DIRECTIONS_BASE = 'https://api.mapbox.com/directions/v5/mapbox/walking';

export interface MapboxLeg {
  distance: number;
  duration: number;
}

export interface MapboxRoute {
  distance: number;
  duration: number;
  geometry: LineString;
  legs: MapboxLeg[];
}

interface MapboxDirectionsResponse {
  code: string;
  message?: string;
  routes: MapboxRoute[];
}

/**
 * Reads the Mapbox token. The web app owns `VITE_MAPBOX_TOKEN`; the server
 * accepts either name so it doesn't need a duplicate copy under a second
 * variable just for this stage.
 */
export function resolveMapboxToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.MAPBOX_TOKEN ?? env.VITE_MAPBOX_TOKEN;
  if (!token) {
    throw new Error(
      'MAPBOX_TOKEN (or VITE_MAPBOX_TOKEN) is not set in the environment.',
    );
  }
  return token;
}

/**
 * Replaces the `access_token` query parameter's value with the literal
 * `REDACTED`. Every caller that turns a Mapbox Directions URL into a cassette
 * key, a cassette filename, or a log/error message MUST route it through
 * this first — the token is a URL query parameter, so skipping this step is
 * the single easiest way to commit a credential in this stage.
 */
export function redactAccessToken(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has('access_token')) {
    parsed.searchParams.set('access_token', 'REDACTED');
  }
  return parsed.toString();
}

/**
 * Builds the Mapbox Directions request URL for a set of curated stops, in
 * `order`. Mapbox coordinates are `lng,lat` — the opposite of this app's
 * `LatLng` shape — so getting this backwards produces a request that is
 * still perfectly well-formed and describes a route in the Indian Ocean.
 */
export function buildDirectionsUrl(stops: CuratedStop[], token: string): string {
  if (stops.length < 2) {
    throw new Error(`buildDirectionsUrl: need at least 2 stops to route, got ${stops.length}.`);
  }
  if (stops.length > MAX_WAYPOINTS) {
    throw new Error(
      `buildDirectionsUrl: Mapbox Directions allows at most ${MAX_WAYPOINTS} waypoints, got ${stops.length}.`,
    );
  }

  const byOrder = [...stops].sort((a, b) => a.order - b.order);
  const coordPart = byOrder
    .map((stop) => `${stop.standingPoint.lng},${stop.standingPoint.lat}`)
    .join(';');

  const params = new URLSearchParams({
    geometries: 'geojson',
    overview: 'full',
    steps: 'false',
    access_token: token,
  });

  return `${DIRECTIONS_BASE}/${coordPart}?${params.toString()}`;
}

/**
 * Wraps a cassette store with record/replay behaviour that redacts the
 * Mapbox access token BEFORE the cassette layer ever computes a key from the
 * URL.
 *
 * The function this returns must be called with the REAL, token-bearing URL
 * (that's what makes the live request work) — the redaction happens
 * internally, in a closure, so the real token never becomes part of the
 * string used to derive the cassette key, the cassette filename, or the
 * stored file content.
 */
export function createRedactingCassetteFetch(
  mode: CassetteMode,
  store: CassetteStore,
  liveFetch: typeof fetch = fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const realUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const redactedUrl = redactAccessToken(realUrl);

    // Ignores whatever `input` the cassette layer passes back in and always
    // issues the real request — the real token only ever flows through this
    // closure, never through a value used to compute or display a key.
    const live: typeof fetch = (async () => liveFetch(realUrl, init)) as typeof fetch;

    return cassetteFetch(mode, store, live)(redactedUrl, init);
  }) as typeof fetch;
}

/**
 * Builds a message naming the offending standing point and its index from a
 * Mapbox 422 error body. Mapbox's message for an unroutable waypoint looks
 * like `"Cannot find route between points 2 and 3."`; when it can be parsed
 * the specific stop is named, and when it can't the raw Mapbox message is
 * still surfaced rather than swallowed.
 */
function describeUnroutableWaypoint(errorBody: string, stops: CuratedStop[]): string {
  let mapboxMessage = errorBody;
  try {
    const parsed = JSON.parse(errorBody) as { message?: string };
    if (parsed.message) mapboxMessage = parsed.message;
  } catch {
    // Not JSON — fall back to the raw body text below.
  }

  const indexMatch = /points?\s+(\d+)/.exec(mapboxMessage);
  const index = indexMatch ? Number(indexMatch[1]) : undefined;
  const stop = index !== undefined ? stops[index] : undefined;

  const stopDescription =
    stop !== undefined
      ? ` — standing point ${index} ("${stop.title}", ${stop.standingPoint.lat},${stop.standingPoint.lng})`
      : '';

  return `Mapbox Directions could not route through a waypoint${stopDescription}: ${mapboxMessage}`;
}

/**
 * Calls Mapbox Directions for the given stops (sorted by `order`) and
 * returns the first route.
 *
 * 5xx and 429 responses are retried with backoff via `fetchWithRetry` (the
 * same helper discovery uses — see `stages/discovery/retry.ts`). A 422 means
 * an unroutable waypoint; it is not retried, and the thrown error names the
 * offending standing point and its index rather than relocating or dropping
 * it silently.
 *
 * `fetchWithRetry` is called with the REDACTED url as its nominal `input` —
 * that value only ever feeds error/log text, never the network call itself
 * — so a retry-exhaustion or 4xx error message is safe to print even though
 * building the real request required the real token.
 */
export async function fetchDirections(
  stops: CuratedStop[],
  deps: { fetch: typeof fetch; token: string },
): Promise<MapboxRoute> {
  const byOrder = [...stops].sort((a, b) => a.order - b.order);
  const realUrl = buildDirectionsUrl(byOrder, deps.token);
  const redactedUrl = redactAccessToken(realUrl);

  let capturedErrorBody: string | null = null;

  const fetchReal: typeof fetch = (async () => {
    const res = await deps.fetch(realUrl);
    if (res.status === 422) {
      // Read the body before returning: fetchWithRetry throws a generic
      // message for a non-retryable 4xx without reading it, so this is the
      // only chance to recover Mapbox's own explanation of which waypoint
      // failed. clone() so the stream is still intact for anything else
      // that might inspect the response.
      capturedErrorBody = await res.clone().text();
    }
    return res;
  }) as typeof fetch;

  let res: Response;
  try {
    res = await fetchWithRetry(fetchReal, redactedUrl, undefined, {});
  } catch (err) {
    if (capturedErrorBody !== null) {
      throw new Error(describeUnroutableWaypoint(capturedErrorBody, byOrder));
    }
    throw err;
  }

  const data = (await res.json()) as MapboxDirectionsResponse;
  if (data.routes.length === 0) {
    throw new Error(`Mapbox Directions returned no routes (code: ${data.code}).`);
  }
  return data.routes[0];
}
