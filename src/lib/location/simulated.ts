import type { Fix, FixListener, LocationProvider } from './types';
import type { LatLng, LineString } from '../../types/tour';
import { haversineM, metresPerDegreeLng, M_PER_DEG_LAT } from '../geo';

export interface SimulatedOptions {
  /** Base walking speed in metres per second. Default 1.4 (normal pace). */
  speedMps?: number;
  /** Milliseconds between emitted fixes. Default 1000. */
  intervalMs?: number;
  /** Reported accuracy on every fix. Default 12. */
  accuracyM?: number;
  /** Maximum random positional offset in metres. Default 0. */
  noiseM?: number;
}

/**
 * Replays a GeoJSON LineString as a stream of location fixes.
 *
 * This is the harness that makes the trigger engine testable without walking
 * around a city. It is also wired into the dev panel at runtime.
 */
export class SimulatedLocation implements LocationProvider {
  private readonly points: LatLng[];
  private readonly cumulativeM: number[];
  private readonly totalM: number;
  private readonly speedMps: number;
  private readonly intervalMs: number;
  private readonly accuracyM: number;
  private readonly noiseM: number;

  private listener: FixListener | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private travelledM = 0;
  private speedMultiplier = 1;
  private paused = false;

  constructor(route: LineString, opts: SimulatedOptions = {}) {
    this.points = route.coordinates.map(([lng, lat]) => ({ lat, lng }));
    this.speedMps = opts.speedMps ?? 1.4;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.accuracyM = opts.accuracyM ?? 12;
    this.noiseM = opts.noiseM ?? 0;

    this.cumulativeM = [0];
    for (let i = 1; i < this.points.length; i++) {
      this.cumulativeM.push(
        this.cumulativeM[i - 1] + haversineM(this.points[i - 1], this.points[i]),
      );
    }
    this.totalM = this.cumulativeM[this.cumulativeM.length - 1] ?? 0;
  }

  start(listener: FixListener): void {
    this.listener = listener;
    this.emitCurrent();
    this.timer = setInterval(() => {
      if (this.paused) return;
      const step = this.speedMps * this.speedMultiplier * (this.intervalMs / 1000);
      this.travelledM = Math.min(this.travelledM + step, this.totalM);
      this.emitCurrent();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listener = null;
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Jump to a fraction (0..1) of the way along the route. */
  jumpTo(fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    this.travelledM = this.totalM * clamped;
  }

  /** Emit a specific fix immediately, bypassing the route. */
  injectFix(fix: Fix): void {
    this.listener?.(fix);
  }

  /** Fraction of the route covered so far, 0..1. */
  get progress(): number {
    return this.totalM === 0 ? 0 : this.travelledM / this.totalM;
  }

  private emitCurrent(): void {
    if (!this.listener) return;
    const p = this.positionAt(this.travelledM);
    const jittered = this.applyNoise(p);
    this.listener({
      lat: jittered.lat,
      lng: jittered.lng,
      accuracyM: this.accuracyM,
      timestamp: Date.now(),
    });
  }

  /** Interpolates a coordinate at `distanceM` along the route. */
  private positionAt(distanceM: number): LatLng {
    if (this.points.length === 0) return { lat: 0, lng: 0 };
    if (this.points.length === 1) return this.points[0];

    for (let i = 1; i < this.cumulativeM.length; i++) {
      if (distanceM <= this.cumulativeM[i]) {
        const segStart = this.cumulativeM[i - 1];
        const segLen = this.cumulativeM[i] - segStart;
        const t = segLen === 0 ? 0 : (distanceM - segStart) / segLen;
        const a = this.points[i - 1];
        const b = this.points[i];
        return {
          lat: a.lat + (b.lat - a.lat) * t,
          lng: a.lng + (b.lng - a.lng) * t,
        };
      }
    }
    return this.points[this.points.length - 1];
  }

  private applyNoise(p: LatLng): LatLng {
    if (this.noiseM === 0) return p;
    const angle = Math.random() * 2 * Math.PI;
    const radius = Math.random() * this.noiseM;
    return {
      lat: p.lat + (Math.sin(angle) * radius) / M_PER_DEG_LAT,
      lng: p.lng + (Math.cos(angle) * radius) / metresPerDegreeLng(p.lat),
    };
  }
}
