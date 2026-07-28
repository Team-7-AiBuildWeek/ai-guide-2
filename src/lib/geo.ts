import type { LatLng, LineString } from '../types/tour';

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

/** Shortest distance in metres from a point to a 2-vertex segment. */
function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const pl = toLocalXY(p, a);
  const bl = toLocalXY(b, a);

  const lengthSq = bl.x ** 2 + bl.y ** 2;
  if (lengthSq === 0) return haversineM(p, a);

  // Projection parameter, clamped to the segment.
  let t = (pl.x * bl.x + pl.y * bl.y) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const dx = pl.x - t * bl.x;
  const dy = pl.y - t * bl.y;
  return Math.sqrt(dx ** 2 + dy ** 2);
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
