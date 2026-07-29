import { haversineM, type CuratedStop, type LatLng, type LineString } from '@ai-guide/shared';
import { fetchDirections } from './mapbox.ts';

export { MAX_WAYPOINTS, buildDirectionsUrl, resolveMapboxToken, redactAccessToken, createRedactingCassetteFetch, fetchDirections } from './mapbox.ts';
export type { MapboxLeg, MapboxRoute } from './mapbox.ts';

export interface Leg {
  distanceM: number;
  durationS: number;
}

export interface RouteResult {
  /** The line the map draws. Coordinates are `[lng, lat]` — Mapbox's order. */
  line: LineString;
  /** One per gap between consecutive stops. */
  legs: Leg[];
  /** One per leg, ~25% along it — fires on departure, not arrival. */
  walkCuePoints: LatLng[];
  /** One per stop, in the same order. */
  triggerRadiiM: number[];
  estimatedMin: number;
  overBudget: boolean;
}

const MIN_RADIUS_M = 25;
const MAX_RADIUS_M = 60;
const RADIUS_FACTOR = 0.4;

/**
 * A stop's trigger radius, from the distance to its NEAREST neighbour
 * (whichever of predecessor/successor is closer) — not just the next stop.
 *
 * The floor (25m) stops a radius shrinking below what consumer GPS can
 * resolve; the ceiling (60m) stops a long leg producing a radius so wide it
 * fires two streets early. With curation's >=100m minimum separation
 * between consecutive stops, two adjacent stops get 40m each and a 20m gap
 * left over — radii cannot overlap by construction.
 */
export function deriveRadiusM(distanceToNearestStopM: number): number {
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, RADIUS_FACTOR * distanceToNearestStopM));
}

/**
 * One trigger radius per stop (in `order`), each derived from the distance
 * to that stop's nearest neighbour among {predecessor, successor}. The first
 * and last stops only have one neighbour each.
 */
export function deriveTriggerRadii(stops: CuratedStop[]): number[] {
  const byOrder = [...stops].sort((a, b) => a.order - b.order);
  return byOrder.map((stop, i) => {
    const prev = byOrder[i - 1];
    const next = byOrder[i + 1];
    const distances = [prev, next]
      .filter((neighbour): neighbour is CuratedStop => neighbour !== undefined)
      .map((neighbour) => haversineM(stop.standingPoint, neighbour.standingPoint));
    return deriveRadiusM(Math.min(...distances));
  });
}

function toLatLng([lng, lat]: [number, number]): LatLng {
  return { lat, lng };
}

function lineLengthM(line: LineString): number {
  const coords = line.coordinates;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(toLatLng(coords[i - 1]), toLatLng(coords[i]));
  }
  return total;
}

/**
 * Interpolates the point at `fraction` (0..1) of `line`'s total arc length,
 * walking the line's own vertices — not a straight line between its
 * endpoints. `fraction` is clamped to [0, 1].
 */
export function walkCuePoint(line: LineString, fraction: number): LatLng {
  const coords = line.coordinates;
  if (coords.length === 0) {
    throw new Error('walkCuePoint: line has no coordinates.');
  }
  if (coords.length === 1) {
    return toLatLng(coords[0]);
  }

  const total = lineLengthM(line);
  const target = Math.max(0, Math.min(total, fraction * total));

  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = toLatLng(coords[i - 1]);
    const b = toLatLng(coords[i]);
    const segmentM = haversineM(a, b);
    const isLastSegment = i === coords.length - 1;

    if (walked + segmentM >= target || isLastSegment) {
      const remaining = target - walked;
      const t = segmentM === 0 ? 0 : Math.min(1, remaining / segmentM);
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    walked += segmentM;
  }

  return toLatLng(coords[coords.length - 1]);
}

/** ~15 characters/second — a rough, widely-used estimate for spoken narration. */
export const speakingSeconds = (script: string): number => script.length / 15;

/** Baseline seconds spent standing at a stop, independent of narration length — a guess, flagged for tuning against a real walk. */
export const DWELL_SECONDS = 60;

/**
 * Narration scripts do not exist yet at this stage (Task 8 writes them), so
 * dwell time per stop is `DWELL_SECONDS` plus a NOMINAL speaking allowance —
 * `speakingSeconds` applied to a placeholder script length standing in for a
 * real one. Task 8 should replace this call with `speakingSeconds(actualScript)`
 * per stop once real scripts exist, using the exported `speakingSeconds`
 * directly rather than re-deriving the estimate.
 */
const NOMINAL_STOP_SCRIPT_CHARS = 600;
const NOMINAL_SPEAKING_ALLOWANCE_S = speakingSeconds('x'.repeat(NOMINAL_STOP_SCRIPT_CHARS));

const BUDGET_OVERRUN_FACTOR = 1.15;
const WALK_CUE_FRACTION = 0.25;

/**
 * Turns curated stops into the walking route: calls Mapbox Directions, then
 * derives everything the trigger engine and the map need from the result.
 *
 * Returns `overBudget` as data rather than re-curating. Bounding a retry
 * against a paid API is the orchestrator's job (Task 10); splitting that
 * responsibility across two modules is how an unbounded loop gets built by
 * accident.
 */
export async function route(
  stops: CuratedStop[],
  budgetMin: number,
  deps: { fetch: typeof fetch; token: string },
): Promise<RouteResult> {
  const byOrder = [...stops].sort((a, b) => a.order - b.order);

  const mapboxRoute = await fetchDirections(byOrder, deps);

  const legs: Leg[] = mapboxRoute.legs.map((leg) => ({
    distanceM: leg.distance,
    durationS: leg.duration,
  }));

  const totalLegDistanceM = legs.reduce((sum, leg) => sum + leg.distanceM, 0);
  let cumulativeM = 0;
  const walkCuePoints: LatLng[] = legs.map((leg) => {
    const targetM = cumulativeM + WALK_CUE_FRACTION * leg.distanceM;
    cumulativeM += leg.distanceM;
    const fraction = totalLegDistanceM === 0 ? 0 : targetM / totalLegDistanceM;
    return walkCuePoint(mapboxRoute.geometry, fraction);
  });

  const triggerRadiiM = deriveTriggerRadii(byOrder);

  const totalLegDurationS = legs.reduce((sum, leg) => sum + leg.durationS, 0);
  const dwellPerStopS = DWELL_SECONDS + NOMINAL_SPEAKING_ALLOWANCE_S;
  const totalDwellS = byOrder.length * dwellPerStopS;
  const estimatedMin = (totalLegDurationS + totalDwellS) / 60;
  const overBudget = estimatedMin > budgetMin * BUDGET_OVERRUN_FACTOR;

  return {
    line: mapboxRoute.geometry,
    legs,
    walkCuePoints,
    triggerRadiiM,
    estimatedMin,
    overBudget,
  };
}
