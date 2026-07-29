// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { M_PER_DEG_LAT, haversineM, type CuratedStop, type LatLng, type LineString } from '@ai-guide/shared';
import { FileCassetteStore } from '../../cassette/index.ts';
import { createRedactingCassetteFetch } from './mapbox.ts';
import {
  route,
  deriveRadiusM,
  deriveTriggerRadii,
  walkCuePoint,
  speakingSeconds,
  DWELL_SECONDS,
} from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', '..', '..', 'cassettes');
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

/** A straight north-running line of the given length in metres, starting near Bratislava. */
function straightLineOfLengthM(m: number): LineString {
  const originLat = 48.14;
  const originLng = 17.11;
  const dLat = m / M_PER_DEG_LAT;
  return {
    type: 'LineString',
    coordinates: [
      [originLng, originLat],
      [originLng, originLat + dLat],
    ],
  };
}

/** Distance in metres from the start of `line` to `point`, for a straight 2-point line. */
function distanceAlongM(line: LineString, point: LatLng): number {
  const [lng0, lat0] = line.coordinates[0];
  return haversineM({ lat: lat0, lng: lng0 }, point);
}

describe('deriveRadiusM', () => {
  it('derives a radius that cannot overlap the neighbouring stop', () => {
    expect(deriveRadiusM(100)).toBe(40); // 0.4 x 100
    expect(deriveRadiusM(50)).toBe(25); // floor
    expect(deriveRadiusM(400)).toBe(60); // ceiling
  });
});

describe('deriveTriggerRadii', () => {
  it('uses the NEARER neighbour, not just the next stop', () => {
    // Stop 1's predecessor is 90m away; its successor is 500m away. The
    // radius must come from the 90m distance (-> 36m), not the 500m one
    // (which would floor/ceiling to something quite different).
    const p0 = { lat: 48.0, lng: 17.0 };
    const p1 = { lat: p0.lat + 90 / M_PER_DEG_LAT, lng: 17.0 };
    const p2 = { lat: p1.lat + 500 / M_PER_DEG_LAT, lng: 17.0 };

    const stops = [stop(0, p0.lat, p0.lng), stop(1, p1.lat, p1.lng), stop(2, p2.lat, p2.lng)];
    const radii = deriveTriggerRadii(stops);

    expect(radii[1]).toBeCloseTo(deriveRadiusM(90), 0);
    expect(radii[1]).not.toBeCloseTo(deriveRadiusM(500), 0);
  });

  it('gives the first and last stops a radius from their single neighbour', () => {
    const p0 = { lat: 48.0, lng: 17.0 };
    const p1 = { lat: p0.lat + 150 / M_PER_DEG_LAT, lng: 17.0 };
    const stops = [stop(0, p0.lat, p0.lng), stop(1, p1.lat, p1.lng)];
    const radii = deriveTriggerRadii(stops);

    expect(radii[0]).toBeCloseTo(deriveRadiusM(150), 0);
    expect(radii[1]).toBeCloseTo(deriveRadiusM(150), 0);
  });

  it('is independent of input array order (sorts by `order` first)', () => {
    const p0 = { lat: 48.0, lng: 17.0 };
    const p1 = { lat: p0.lat + 90 / M_PER_DEG_LAT, lng: 17.0 };
    const p2 = { lat: p1.lat + 500 / M_PER_DEG_LAT, lng: 17.0 };
    const inOrder = [stop(0, p0.lat, p0.lng), stop(1, p1.lat, p1.lng), stop(2, p2.lat, p2.lng)];
    const shuffled = [inOrder[2], inOrder[0], inOrder[1]];

    expect(deriveTriggerRadii(shuffled)).toEqual(deriveTriggerRadii(inOrder));
  });
});

describe('walkCuePoint', () => {
  it('places the walk cue about a quarter along the leg', () => {
    const line = straightLineOfLengthM(1000);
    const cue = walkCuePoint(line, 0.25);
    expect(distanceAlongM(line, cue)).toBeCloseTo(250, -1);
  });

  it('returns the start point at fraction 0 and the end point at fraction 1', () => {
    const line = straightLineOfLengthM(1000);
    expect(distanceAlongM(line, walkCuePoint(line, 0))).toBeCloseTo(0, -1);
    expect(distanceAlongM(line, walkCuePoint(line, 1))).toBeCloseTo(1000, -1);
  });

  it('walks a multi-segment line by real arc length, not straight-line distance to the endpoint', () => {
    // An L-shaped line: 100m north, then 100m east. The 50%-along point must
    // be at the corner (100m walked), not at the geometric midpoint between
    // the two endpoints (which is off the line entirely).
    const originLat = 48.14;
    const originLng = 17.11;
    const corner = { lat: originLat + 100 / M_PER_DEG_LAT, lng: originLng };
    const line: LineString = {
      type: 'LineString',
      coordinates: [
        [originLng, originLat],
        [corner.lng, corner.lat],
        [corner.lng, corner.lat + 100 / M_PER_DEG_LAT],
      ],
    };
    const cue = walkCuePoint(line, 0.5);
    expect(cue.lat).toBeCloseTo(corner.lat, 4);
    expect(cue.lng).toBeCloseTo(corner.lng, 4);
  });
});

describe('speakingSeconds', () => {
  it('estimates ~15 characters per second', () => {
    expect(speakingSeconds('x'.repeat(150))).toBeCloseTo(10, 5);
  });
});

describe('DWELL_SECONDS', () => {
  it('matches the documented baseline', () => {
    expect(DWELL_SECONDS).toBe(60);
  });
});

function fakeMapboxResponse(legs: { distance: number; duration: number }[]): Response {
  const coordinates: [number, number][] = [
    [17.1, 48.1422],
    [17.1047, 48.1419],
    [17.1068, 48.1451],
  ];
  const body = {
    code: 'Ok',
    routes: [
      {
        distance: legs.reduce((s, l) => s + l.distance, 0),
        duration: legs.reduce((s, l) => s + l.duration, 0),
        geometry: { type: 'LineString', coordinates },
        legs,
      },
    ],
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

const THREE_STOPS: CuratedStop[] = [
  stop(0, 48.1422, 17.1),
  stop(1, 48.1419, 17.1047),
  stop(2, 48.1451, 17.1068),
];

describe('route (fake Mapbox response)', () => {
  it('produces one leg per gap, one trigger radius per stop, one walk cue per leg', async () => {
    const fakeFetch: typeof fetch = async () =>
      fakeMapboxResponse([
        { distance: 1200, duration: 900 },
        { distance: 1300, duration: 950 },
      ]);

    const result = await route(THREE_STOPS, 90, { fetch: fakeFetch, token: 'tok' });

    expect(result.legs).toHaveLength(2);
    expect(result.triggerRadiiM).toHaveLength(3);
    expect(result.walkCuePoints).toHaveLength(2);
    expect(result.line.coordinates.length).toBeGreaterThan(0);
  });

  it('does not re-curate: overBudget is returned as data, not thrown or retried', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      // Legs alone total 100 minutes of walking — comfortably over any
      // sane budget once dwell is added.
      return fakeMapboxResponse([{ distance: 5000, duration: 6000 }, { distance: 100, duration: 60 }]);
    };

    const result = await route(THREE_STOPS, 20, { fetch: fakeFetch, token: 'tok' });

    expect(result.overBudget).toBe(true);
    expect(calls).toBe(1); // exactly one Mapbox call — no re-curation loop here
  });

  it('does not flag overBudget for a route comfortably inside the budget', async () => {
    const fakeFetch: typeof fetch = async () =>
      fakeMapboxResponse([
        { distance: 500, duration: 400 },
        { distance: 500, duration: 400 },
      ]);

    const result = await route(THREE_STOPS, 90, { fetch: fakeFetch, token: 'tok' });
    expect(result.overBudget).toBe(false);
  });
});

describe('route — recorded Bratislava cassette', () => {
  it('produces a plausible walking tour: correct coordinate order and sane distance/duration', async () => {
    const raw = await readFile(
      join(cassetteDir, 'synthetic', 'curation-bratislava.json'),
      'utf8',
    );
    const cassette = JSON.parse(raw) as { stops: CuratedStop[] };

    const store = new FileCassetteStore(cassetteDir);
    // Replay never touches `live` — the redacted URL is all replay needs to
    // find the cassette entry, so the token value here is a throwaway.
    const unusedLive: typeof fetch = async () => {
      throw new Error('replay must never call through to a live fetch');
    };
    const fetchImpl = createRedactingCassetteFetch('replay', store, unusedLive);

    const result = await route(cassette.stops, 90, { fetch: fetchImpl, token: 'unused-in-replay' });

    // Failure mode 1: a lng/lat swap produces a valid-looking route in the
    // Indian Ocean. Every coordinate on the real route must stay within a
    // couple of kilometres of central Bratislava.
    for (const [lng, lat] of result.line.coordinates) {
      expect(haversineM({ lat, lng }, BRATISLAVA_CENTRE)).toBeLessThan(2000);
    }
    for (const cue of result.walkCuePoints) {
      expect(haversineM(cue, BRATISLAVA_CENTRE)).toBeLessThan(2000);
    }

    const totalDistanceM = result.legs.reduce((s, l) => s + l.distanceM, 0);
    const totalWalkingMin = result.legs.reduce((s, l) => s + l.durationS, 0) / 60;

    // A walking tour of Bratislava's old town should be roughly 2-4km and
    // 30-60 minutes of *walking* time (before dwell/narration is added).
    expect(totalDistanceM).toBeGreaterThan(1500);
    expect(totalDistanceM).toBeLessThan(5000);
    expect(totalWalkingMin).toBeGreaterThan(10);
    expect(totalWalkingMin).toBeLessThan(70);

    expect(result.legs).toHaveLength(cassette.stops.length - 1);
    expect(result.triggerRadiiM).toHaveLength(cassette.stops.length);
    expect(result.walkCuePoints).toHaveLength(cassette.stops.length - 1);
  });
});
