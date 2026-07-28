import { describe, it, expect } from 'vitest';
import {
  haversineM,
  distanceToLineStringM,
  metresPerDegreeLng,
  fractionAlongLineString,
} from './geo';
import type { LineString } from '@ai-guide/shared';

describe('metresPerDegreeLng', () => {
  it('equals the equatorial constant at the equator', () => {
    expect(metresPerDegreeLng(0)).toBeCloseTo(111320, 0);
  });

  it('shrinks with latitude', () => {
    // cos(52.37Â°) â‰ˆ 0.6106
    expect(metresPerDegreeLng(52.3731)).toBeGreaterThan(67000);
    expect(metresPerDegreeLng(52.3731)).toBeLessThan(68500);
  });
});

describe('haversineM', () => {
  it('returns 0 for identical points', () => {
    const p = { lat: 52.3731, lng: 4.8936 };
    expect(haversineM(p, p)).toBe(0);
  });

  it('measures one degree of longitude at the equator', () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(d).toBeGreaterThan(111000);
    expect(d).toBeLessThan(111600);
  });

  it('measures a short city-scale distance', () => {
    // Dam Square to the Royal Palace, Amsterdam: same latitude, ~163 m apart.
    const d = haversineM(
      { lat: 52.3731, lng: 4.8936 },
      { lat: 52.3731, lng: 4.8912 },
    );
    expect(d).toBeGreaterThan(155);
    expect(d).toBeLessThan(172);
  });

  it('is symmetric', () => {
    const a = { lat: 52.3731, lng: 4.8936 };
    const b = { lat: 52.3752, lng: 4.884 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
  });
});

describe('distanceToLineStringM', () => {
  const line: LineString = {
    type: 'LineString',
    coordinates: [
      [4.8936, 52.3731],
      [4.8912, 52.3731],
    ],
  };

  it('returns ~0 for a point on the line', () => {
    expect(distanceToLineStringM({ lat: 52.3731, lng: 4.8924 }, line)).toBeLessThan(2);
  });

  it('measures perpendicular offset from the line', () => {
    // ~0.0009 degrees of latitude north of the segment is ~100 m.
    const d = distanceToLineStringM({ lat: 52.374, lng: 4.8924 }, line);
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(110);
  });

  it('measures distance to the nearest endpoint when past the segment end', () => {
    const d = distanceToLineStringM({ lat: 52.3731, lng: 4.89 }, line);
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(90);
  });
});

describe('fractionAlongLineString', () => {
  // Deliberately unevenly spaced: P0â†’P1 is ~163 m, P1â†’P2 is much longer, so a
  // naive index/(count-1) fraction (0.5 for the middle vertex) would be very
  // wrong. This mirrors the real bug: the dev panel's "jump to" buttons used
  // stop index instead of arc length, so most stops on the real (uneven)
  // fixture route were never reached.
  const line: LineString = {
    type: 'LineString',
    coordinates: [
      [4.8936, 52.3731], // P0
      [4.8912, 52.3731], // P1
      [4.884, 52.3731], // P2 â€” much further from P1 than P1 is from P0
    ],
  };

  const p0 = { lat: 52.3731, lng: 4.8936 };
  const p1 = { lat: 52.3731, lng: 4.8912 };
  const p2 = { lat: 52.3731, lng: 4.884 };
  const d01 = haversineM(p0, p1);
  const d12 = haversineM(p1, p2);
  const total = d01 + d12;

  it('returns ~0 at the route start', () => {
    expect(fractionAlongLineString(p0, line)).toBeCloseTo(0, 3);
  });

  it('returns ~1 at the route end', () => {
    expect(fractionAlongLineString(p2, line)).toBeCloseTo(1, 3);
  });

  it('is proportional to real arc length, not vertex index, on an unevenly spaced route', () => {
    const expected = d01 / total;
    const fraction = fractionAlongLineString(p1, line);
    expect(fraction).toBeCloseTo(expected, 3);
    // The naive index-based fraction would have placed this vertex at 0.5.
    expect(fraction).toBeLessThan(0.3);
  });

  it('returns the expected fraction for a point at a known segment midpoint', () => {
    const mid = { lat: 52.3731, lng: (p0.lng + p1.lng) / 2 };
    const expected = d01 / 2 / total;
    expect(fractionAlongLineString(mid, line)).toBeCloseTo(expected, 3);
  });

  it('projects a point off to the side onto the nearest point on the route', () => {
    const onLineMid = { lat: 52.3731, lng: (p0.lng + p1.lng) / 2 };
    const offToSide = { lat: 52.374, lng: (p0.lng + p1.lng) / 2 }; // ~100 m north
    const expected = d01 / 2 / total;
    expect(fractionAlongLineString(offToSide, line)).toBeCloseTo(expected, 2);
    // A perpendicular nudge shouldn't meaningfully change where it lands
    // along the route.
    const delta = Math.abs(
      fractionAlongLineString(offToSide, line) - fractionAlongLineString(onLineMid, line),
    );
    expect(delta).toBeLessThan(0.01);
  });
});
