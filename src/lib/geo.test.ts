import { describe, it, expect } from 'vitest';
import { haversineM, distanceToLineStringM, metresPerDegreeLng } from './geo';
import type { LineString } from '../types/tour';

describe('metresPerDegreeLng', () => {
  it('equals the equatorial constant at the equator', () => {
    expect(metresPerDegreeLng(0)).toBeCloseTo(111320, 0);
  });

  it('shrinks with latitude', () => {
    // cos(52.37°) ≈ 0.6106
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
