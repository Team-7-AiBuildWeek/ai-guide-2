import type { Segment, Tour } from '../../types/tour';
import { metresPerDegreeLng } from '../geo';

/** Four stops in a straight east-west line, roughly 165 m apart. */
export const STOP_COORDS = [
  { lat: 52.3731, lng: 4.8936 },
  { lat: 52.3731, lng: 4.8912 },
  { lat: 52.3731, lng: 4.8888 },
  { lat: 52.3731, lng: 4.8864 },
];

export function makeSegment(index: number, overrides: Partial<Segment> = {}): Segment {
  return {
    id: `seg-${index}`,
    kind: 'stop',
    order: index,
    title: `Stop ${index}`,
    script: `Narration for stop ${index}.`,
    audioUrl: null,
    durationMs: null,
    trigger: STOP_COORDS[index] ?? null,
    triggerRadiusM: 25,
    poiId: `poi-${index}`,
    ...overrides,
  };
}

export function makeTour(overrides: Partial<Tour> = {}): Tour {
  return {
    id: 'tour-test',
    city: 'Amsterdam',
    language: 'en',
    persona: 'historian',
    title: 'Test Tour',
    segments: STOP_COORDS.map((_, i) => makeSegment(i)),
    routeGeoJson: {
      type: 'LineString',
      coordinates: STOP_COORDS.map((c) => [c.lng, c.lat] as [number, number]),
    },
    estimatedDurationMin: 30,
    ...overrides,
  };
}

/** Builds a fix at a given coordinate with a given reported accuracy. */
export function fixAt(
  coord: { lat: number; lng: number },
  accuracyM = 10,
  timestamp = 1_000_000,
) {
  return { lat: coord.lat, lng: coord.lng, accuracyM, timestamp };
}

/** Offsets a coordinate east by `metres`. */
export function eastOf(coord: { lat: number; lng: number }, metres: number) {
  return { lat: coord.lat, lng: coord.lng + metres / metresPerDegreeLng(coord.lat) };
}
