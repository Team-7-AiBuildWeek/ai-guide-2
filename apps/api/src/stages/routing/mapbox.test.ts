import { describe, it, expect } from 'vitest';
import type { CuratedStop } from '@ai-guide/shared';
import { haversineM } from '@ai-guide/shared';
import type { CassetteStore, RecordedResponse } from '../../cassette/index.ts';
import { cassetteFilename } from '../../cassette/index.ts';
import {
  MAX_WAYPOINTS,
  buildDirectionsUrl,
  redactAccessToken,
  createRedactingCassetteFetch,
  fetchDirections,
} from './mapbox.ts';

const BRATISLAVA_CENTRE = { lat: 48.1436, lng: 17.1085 };

function stop(order: number, lat: number, lng: number, title = `Stop ${order}`): CuratedStop {
  return {
    wikidataQids: [`Q${1000 + order}`],
    standingPoint: { lat, lng },
    title,
    why: 'x',
    order,
  };
}

const STOPS: CuratedStop[] = [
  stop(0, 48.1422, 17.1),
  stop(1, 48.1419, 17.1047),
  stop(2, 48.1451, 17.1068),
];

function fakeMapboxResponse(overrides: Record<string, unknown> = {}): Response {
  const body = {
    code: 'Ok',
    routes: [
      {
        distance: 2500,
        duration: 1800,
        geometry: {
          type: 'LineString',
          coordinates: [
            [17.1, 48.1422],
            [17.1047, 48.1419],
            [17.1068, 48.1451],
          ],
        },
        legs: [
          { distance: 1200, duration: 900 },
          { distance: 1300, duration: 900 },
        ],
      },
    ],
    ...overrides,
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('buildDirectionsUrl', () => {
  it('orders coordinates as lng,lat — Mapbox order, not LatLng order', () => {
    const url = buildDirectionsUrl(STOPS, 'tok123');
    const coordSegment = url.split('/walking/')[1].split('?')[0];
    const first = coordSegment.split(';')[0];
    const [lngStr, latStr] = first.split(',');

    // Bratislava is at roughly lat 48, lng 17. If lat/lng were swapped, the
    // "lng" value here would be ~48 instead of ~17 — a coordinate order bug
    // that still produces a syntactically valid request, just one describing
    // a route in the Indian Ocean.
    expect(Number(lngStr)).toBeCloseTo(17.1, 1);
    expect(Number(latStr)).toBeCloseTo(48.1422, 3);
  });

  it('includes every stop, sorted by order, regardless of input order', () => {
    const shuffled = [STOPS[2], STOPS[0], STOPS[1]];
    const url = buildDirectionsUrl(shuffled, 'tok123');
    const coordSegment = url.split('/walking/')[1].split('?')[0];
    expect(coordSegment.split(';')).toHaveLength(3);
    expect(coordSegment.split(';')[0]).toBe('17.1,48.1422');
  });

  it('sets the expected query parameters', () => {
    const url = buildDirectionsUrl(STOPS, 'tok123');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('geometries')).toBe('geojson');
    expect(parsed.searchParams.get('overview')).toBe('full');
    expect(parsed.searchParams.get('steps')).toBe('false');
    expect(parsed.searchParams.get('access_token')).toBe('tok123');
  });

  it('rejects fewer than 2 stops', () => {
    expect(() => buildDirectionsUrl([STOPS[0]], 'tok123')).toThrow(/at least 2/);
  });

  it('rejects more than 25 waypoints with a clear message rather than sending the request', () => {
    const many = Array.from({ length: MAX_WAYPOINTS + 1 }, (_, i) => stop(i, 48.14 + i * 0.001, 17.1));
    expect(() => buildDirectionsUrl(many, 'tok123')).toThrow(/25/);
  });
});

describe('redactAccessToken', () => {
  it('replaces the token value with REDACTED and leaves other params intact', () => {
    const url = buildDirectionsUrl(STOPS, 'sk.super-secret-value');
    const redacted = redactAccessToken(url);
    expect(redacted).not.toContain('super-secret-value');
    expect(redacted).toContain('access_token=REDACTED');
    const parsed = new URL(redacted);
    expect(parsed.searchParams.get('geometries')).toBe('geojson');
  });
});

class SpyCassetteStore implements CassetteStore {
  keys: string[] = [];
  bodies: string[] = [];

  async get(): Promise<RecordedResponse | null> {
    return null;
  }

  async put(key: string, value: RecordedResponse): Promise<void> {
    this.keys.push(key);
    this.bodies.push(value.body);
  }
}

describe('createRedactingCassetteFetch — token leak guard', () => {
  it('never lets the access token reach the cassette key, its derived filename, or the stored body', async () => {
    const token = 'sk.THIS_IS_THE_SECRET_TOKEN_VALUE_abc123';
    const store = new SpyCassetteStore();
    const live: typeof fetch = async () => fakeMapboxResponse();

    const fetchImpl = createRedactingCassetteFetch('record', store, live);
    const realUrl = buildDirectionsUrl(STOPS, token);

    const res = await fetchImpl(realUrl);
    expect(res.status).toBe(200); // the live call itself still used the real token successfully

    expect(store.keys).toHaveLength(1);
    expect(store.keys[0]).not.toContain(token);
    expect(cassetteFilename(store.keys[0])).not.toContain(token);
    expect(store.bodies[0]).not.toContain(token);
  });

  it('still performs the real network call with the real token', async () => {
    const token = 'sk.another-secret-value';
    const store = new SpyCassetteStore();
    let seenUrl = '';
    const live: typeof fetch = async (input) => {
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return fakeMapboxResponse();
    };

    const fetchImpl = createRedactingCassetteFetch('record', store, live);
    await fetchImpl(buildDirectionsUrl(STOPS, token));

    expect(seenUrl).toContain(token);
  });
});

describe('fetchDirections', () => {
  it('returns the first route, with a plausible geometry near Bratislava', async () => {
    const fakeFetch: typeof fetch = async () => fakeMapboxResponse();
    const result = await fetchDirections(STOPS, { fetch: fakeFetch, token: 'tok' });

    expect(result.distance).toBe(2500);
    expect(result.legs).toHaveLength(2);

    for (const [lng, lat] of result.geometry.coordinates) {
      // Guards the lng/lat swap bug: a swapped coordinate here would be
      // roughly (17, 48) interpreted as (lat 17, lng 48) — over 3000km away,
      // not "a couple of kilometres".
      const distanceFromCentreM = haversineM({ lat, lng }, BRATISLAVA_CENTRE);
      expect(distanceFromCentreM).toBeLessThan(2000);
    }
  });

  it('retries a 502 and succeeds on a later attempt, reusing fetchWithRetry', async () => {
    let calls = 0;
    const flakyFetch: typeof fetch = async () => {
      calls += 1;
      if (calls < 2) return new Response('bad gateway', { status: 502 });
      return fakeMapboxResponse();
    };

    const result = await fetchDirections(STOPS, { fetch: flakyFetch, token: 'tok' });
    expect(calls).toBe(2);
    expect(result.legs).toHaveLength(2);
  });

  it('fails loudly on a 422, naming the offending standing point and its index', async () => {
    const badFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ code: 'NoRoute', message: 'Cannot find route between points 1 and 2.' }),
        { status: 422 },
      );

    await expect(fetchDirections(STOPS, { fetch: badFetch, token: 'tok' })).rejects.toThrow(
      /Stop 1/,
    );
  });

  it('never retries a 422 (single attempt, immediate failure)', async () => {
    let calls = 0;
    const badFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 'NoRoute', message: 'points 0 and 1' }), {
        status: 422,
      });
    };

    await expect(fetchDirections(STOPS, { fetch: badFetch, token: 'tok' })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
