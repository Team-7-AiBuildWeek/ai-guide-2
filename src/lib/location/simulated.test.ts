import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimulatedLocation } from './simulated';
import { haversineM } from '../geo';
import type { Fix } from './types';
import type { LineString } from '../../types/tour';

// A straight ~330 m east-west line across Dam Square, Amsterdam.
const route: LineString = {
  type: 'LineString',
  coordinates: [
    [4.8936, 52.3731],
    [4.8888, 52.3731],
  ],
};

describe('SimulatedLocation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits the route start as its first fix', () => {
    const fixes: Fix[] = [];
    const sim = new SimulatedLocation(route, { accuracyM: 10 });
    sim.start((f) => fixes.push(f));

    vi.advanceTimersByTime(0);

    expect(fixes).toHaveLength(1);
    expect(fixes[0].lat).toBeCloseTo(52.3731, 4);
    expect(fixes[0].lng).toBeCloseTo(4.8936, 4);
    sim.stop();
  });

  it('advances along the route over time', () => {
    const fixes: Fix[] = [];
    // 1.4 m/s is a normal walking pace; one fix per second.
    const sim = new SimulatedLocation(route, { speedMps: 1.4, intervalMs: 1000, accuracyM: 10 });
    sim.start((f) => fixes.push(f));

    vi.advanceTimersByTime(10_000);

    expect(fixes.length).toBeGreaterThanOrEqual(10);
    const travelled = haversineM(fixes[0], fixes[fixes.length - 1]);
    // 10 s at 1.4 m/s, allowing for interval rounding.
    expect(travelled).toBeGreaterThan(10);
    expect(travelled).toBeLessThan(20);
    sim.stop();
  });

  it('applies the speed multiplier', () => {
    const slow: Fix[] = [];
    const fast: Fix[] = [];

    const a = new SimulatedLocation(route, { speedMps: 1.4, intervalMs: 1000, accuracyM: 10 });
    a.start((f) => slow.push(f));
    vi.advanceTimersByTime(10_000);
    a.stop();

    const b = new SimulatedLocation(route, { speedMps: 1.4, intervalMs: 1000, accuracyM: 10 });
    b.setSpeed(5);
    b.start((f) => fast.push(f));
    vi.advanceTimersByTime(10_000);
    b.stop();

    const slowDist = haversineM(slow[0], slow[slow.length - 1]);
    const fastDist = haversineM(fast[0], fast[fast.length - 1]);
    expect(fastDist).toBeGreaterThan(slowDist * 3);
  });

  it('stops emitting after stop() is called', () => {
    const fixes: Fix[] = [];
    const sim = new SimulatedLocation(route, { intervalMs: 1000, accuracyM: 10 });
    sim.start((f) => fixes.push(f));
    vi.advanceTimersByTime(3000);
    const count = fixes.length;

    sim.stop();
    vi.advanceTimersByTime(5000);

    expect(fixes).toHaveLength(count);
  });

  it('jumpTo moves to a fraction along the route', () => {
    const fixes: Fix[] = [];
    const sim = new SimulatedLocation(route, { intervalMs: 1000, accuracyM: 10 });
    sim.start((f) => fixes.push(f));
    fixes.length = 0;

    sim.jumpTo(1);
    vi.advanceTimersByTime(1000);

    const last = fixes[fixes.length - 1];
    expect(last.lng).toBeCloseTo(4.8888, 4);
  });

  it('injectFix emits an arbitrary fix immediately', () => {
    const fixes: Fix[] = [];
    const sim = new SimulatedLocation(route, { intervalMs: 1000, accuracyM: 10 });
    sim.start((f) => fixes.push(f));
    fixes.length = 0;

    sim.injectFix({ lat: 1, lng: 2, accuracyM: 999, timestamp: 12345 });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toEqual({ lat: 1, lng: 2, accuracyM: 999, timestamp: 12345 });
    sim.stop();
  });

  it('applies accuracy noise within the configured bound', () => {
    const fixes: Fix[] = [];
    const sim = new SimulatedLocation(route, {
      intervalMs: 1000,
      accuracyM: 10,
      noiseM: 5,
    });
    sim.start((f) => fixes.push(f));
    vi.advanceTimersByTime(5000);
    sim.stop();

    for (const f of fixes) {
      expect(f.accuracyM).toBe(10);
    }
    // With noise applied, fixes should not sit exactly on the route latitude.
    const offRoute = fixes.some((f) => Math.abs(f.lat - 52.3731) > 1e-7);
    expect(offRoute).toBe(true);
  });
});
