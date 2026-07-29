import type { LatLng, LineString } from './tour.ts';

const EARTH_RADIUS_M = 6371008.8;

/** Metres per degree of latitude. Effectively constant across the globe. */
export const M_PER_DEG_LAT = 111320;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Metres per degree of longitude at a given latitude.
 *
 * Shared by the simulator and test helpers — do not re-derive this formula
 * elsewhere.
 */
export function metresPerDegreeLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos(toRad(lat));
}

/** Great-circle distance in metres between two coordinates. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Projects lat/lng onto a local planar frame centred on `origin`, in metres.
 * Accurate enough for the sub-kilometre distances a walking tour deals with.
 */
function toLocalXY(p: LatLng, origin: LatLng): { x: number; y: number } {
  return {
    x: (p.lng - origin.lng) * metresPerDegreeLng(origin.lat),
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/**
 * Closest point on a 2-vertex segment to `p`, in the segment's local planar
 * frame. `t` is the clamped projection parameter (0 = at `a`, 1 = at `b`);
 * `distanceM` is the perpendicular (or endpoint) distance to that point.
 *
 * Shared by `distanceToLineStringM` (which only needs `distanceM`) and
 * `fractionAlongLineString` (which also needs `t` to locate the point along
 * the route).
 */
function closestPointOnSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): { distanceM: number; t: number } {
  const pl = toLocalXY(p, a);
  const bl = toLocalXY(b, a);

  const lengthSq = bl.x ** 2 + bl.y ** 2;
  if (lengthSq === 0) return { distanceM: haversineM(p, a), t: 0 };

  // Projection parameter, clamped to the segment.
  let t = (pl.x * bl.x + pl.y * bl.y) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const dx = pl.x - t * bl.x;
  const dy = pl.y - t * bl.y;
  return { distanceM: Math.sqrt(dx ** 2 + dy ** 2), t };
}

/** Shortest distance in metres from a point to a 2-vertex segment. */
function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  return closestPointOnSegment(p, a, b).distanceM;
}

/** Shortest distance in metres from a point to any part of a LineString. */
export function distanceToLineStringM(p: LatLng, line: LineString): number {
  const coords = line.coordinates;
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) {
    return haversineM(p, { lat: coords[0][1], lng: coords[0][0] });
  }

  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const a: LatLng = { lat: coords[i][1], lng: coords[i][0] };
    const b: LatLng = { lat: coords[i + 1][1], lng: coords[i + 1][0] };
    min = Math.min(min, distanceToSegmentM(p, a, b));
  }
  return min;
}

/**
 * Fraction (0..1) of `line`'s total length at the point on it closest to `p`.
 *
 * Used by the dev-panel simulator to jump directly to a stop: a stop's
 * *index* among the tour's segments is not proportional to its distance
 * along the route, so `index / (count - 1)` targets the wrong place on any
 * route that isn't evenly spaced. Projecting the stop's own trigger
 * coordinate onto the route and taking cumulative-distance-to-there is the
 * only fraction that actually lands within the stop's trigger radius.
 */
export function fractionAlongLineString(p: LatLng, line: LineString): number {
  const coords = line.coordinates;
  if (coords.length < 2) return 0;

  const points: LatLng[] = coords.map(([lng, lat]) => ({ lat, lng }));

  const cumulativeM = [0];
  for (let i = 1; i < points.length; i++) {
    cumulativeM.push(cumulativeM[i - 1] + haversineM(points[i - 1], points[i]));
  }
  const totalM = cumulativeM[cumulativeM.length - 1];
  if (totalM === 0) return 0;

  let bestDistanceM = Infinity;
  let bestAlongM = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLenM = haversineM(a, b);
    const { distanceM, t } = closestPointOnSegment(p, a, b);
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM;
      bestAlongM = cumulativeM[i] + t * segLenM;
    }
  }
  return bestAlongM / totalM;
}
