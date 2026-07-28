# Tour Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mobile-first PWA that plays a GPS-triggered audio walking tour from a fixture file, with a simulation harness that makes the trigger engine testable without walking around a city.

**Architecture:** Pure-function trigger engine driven by a swappable `LocationProvider`, feeding a swappable `AudioPlayer`. All three provider interfaces exist from day one so a Capacitor native shell (background GPS) and a real TTS backend can be dropped in later without touching call sites. No backend in this plan — the tour comes from a JSON fixture and narration is spoken by the browser's `speechSynthesis`.

**Tech Stack:** Vite 7, React 19, TypeScript 5.7, Tailwind CSS v4, Mapbox GL JS 3, Vitest 3, `vite-plugin-pwa`.

## Global Constraints

- Node `^20.19.0 || >=22.12.0` required — both `vite` and `jsdom` declare this
  floor. Node 20.17 builds fine but fails the whole test suite with
  `ERR_REQUIRE_ESM` inside jsdom's dependency chain, so a green build is not
  evidence the tests can even run. `.nvmrc` pins 25.2.1.
- TypeScript `strict: true`. No `any` in committed code.
- Every module under `src/lib/` must be free of React imports — they are pure and unit-testable.
- Distances are always metres, named with an `M` suffix (`accuracyM`, `radiusM`). Never mix units.
- Coordinates are always `{ lat, lng }` objects, never `[lng, lat]` tuples, except at the Mapbox and GeoJSON boundaries where the tuple order is `[lng, lat]`.
- Target languages for the product are English, German, French, Spanish, Italian, Dutch. This plan hardcodes one fixture tour in English; the `Tour` type carries `language` so nothing needs restructuring later.
- Commit after every task using Conventional Commits (`feat:`, `test:`, `chore:`).

---

### Task 1: Scaffold, domain types, geo utilities

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`
- Create: `src/types/tour.ts`
- Create: `src/lib/geo.ts`
- Test: `src/lib/geo.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `LatLng`, `Segment`, `SegmentKind`, `Tour` types; `M_PER_DEG_LAT: number`; `metresPerDegreeLng(lat: number): number`; `haversineM(a: LatLng, b: LatLng): number`; `distanceToLineStringM(p: LatLng, line: LineString): number`

`metresPerDegreeLng` is exported because Tasks 2 and 3 both need the same
latitude-dependent conversion. Do not re-derive `111320 * Math.cos(lat)` in
those files — import this instead.

- [ ] **Step 1: Scaffold the project**

```bash
npm create vite@latest . -- --template react-ts
npm install
npm install -D vitest @vitest/ui jsdom
npm install mapbox-gl
npm install -D @types/mapbox-gl
npm install -D tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: Configure Vite for tests and Tailwind**

Replace `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Replace `src/index.css` with a single line:

```css
@import "tailwindcss";
```

- [ ] **Step 3: Define domain types**

Create `src/types/tour.ts`:

```typescript
export interface LatLng {
  lat: number;
  lng: number;
}

/** GeoJSON LineString — note coordinates are [lng, lat] tuples. */
export interface LineString {
  type: 'LineString';
  coordinates: [number, number][];
}

export type SegmentKind = 'intro' | 'stop' | 'walk' | 'outro';

export interface Segment {
  id: string;
  kind: SegmentKind;
  /** Playback order within the tour, ascending from 0. */
  order: number;
  title: string;
  script: string;
  /** null in this plan — narration is spoken by speechSynthesis. */
  audioUrl: string | null;
  durationMs: number | null;
  /** null for intro and outro, which are not location-triggered. */
  trigger: LatLng | null;
  /** Base radius; the engine widens this to match GPS accuracy at runtime. */
  triggerRadiusM: number;
  poiId: string | null;
}

export interface Tour {
  id: string;
  city: string;
  /** BCP-47 tag, e.g. 'en', 'nl'. */
  language: string;
  persona: string;
  title: string;
  segments: Segment[];
  routeGeoJson: LineString;
  estimatedDurationMin: number;
}
```

- [ ] **Step 4: Write the failing geo tests**

Create `src/lib/geo.test.ts`:

```typescript
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
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./geo"`

- [ ] **Step 6: Implement the geo utilities**

Create `src/lib/geo.ts`:

```typescript
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
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 9 tests

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold Vite PWA with tour domain types and geo utilities"
```

---

### Task 2: Location provider interface and simulator

**Files:**
- Create: `src/lib/location/types.ts`
- Create: `src/lib/location/simulated.ts`
- Test: `src/lib/location/simulated.test.ts`

**Interfaces:**
- Consumes: `LatLng`, `LineString` from `src/types/tour.ts`; `haversineM` from `src/lib/geo.ts`
- Produces:
  - `Fix { lat, lng, accuracyM, timestamp }`
  - `FixListener = (fix: Fix) => void`
  - `LocationProvider { start(listener: FixListener): void; stop(): void }`
  - `SimulatedLocation` class with constructor `(route: LineString, opts?: SimulatedOptions)` and extra methods `setSpeed(multiplier: number)`, `jumpTo(fraction: number)`, `injectFix(fix: Fix)`, `pause()`, `resume()`

- [ ] **Step 1: Define the provider interface**

Create `src/lib/location/types.ts`:

```typescript
export interface Fix {
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. Larger is worse. */
  accuracyM: number;
  /** Epoch milliseconds. */
  timestamp: number;
}

export type FixListener = (fix: Fix) => void;

export interface LocationProvider {
  start(listener: FixListener): void;
  stop(): void;
}
```

- [ ] **Step 2: Write the failing simulator tests**

Create `src/lib/location/simulated.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test src/lib/location`
Expected: FAIL — `Failed to resolve import "./simulated"`

- [ ] **Step 4: Implement the simulator**

Create `src/lib/location/simulated.ts`:

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test src/lib/location`
Expected: PASS — 8 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add LocationProvider interface and route simulator"
```

---

### Task 3: Trigger engine

This is the core of the product. Every rule here comes from spec §8.

**Files:**
- Create: `src/lib/trigger/engine.ts`
- Test: `src/lib/trigger/engine.test.ts`
- Create: `src/lib/trigger/testFixtures.ts`

**Interfaces:**
- Consumes: `Tour`, `Segment`, `LatLng` from `src/types/tour.ts`; `Fix` from `src/lib/location/types.ts`; `haversineM`, `distanceToLineStringM` from `src/lib/geo.ts`
- Produces:
  - `EngineEvent = { type: 'fire'; segment: Segment } | { type: 'offRoute'; distanceM: number } | { type: 'backOnRoute' }`
  - `EngineConfig { maxAccuracyM, requiredHits, lookahead, offRouteThresholdM, offRouteDurationMs }`
  - `TriggerEngine` class: `constructor(tour: Tour, config?: Partial<EngineConfig>)`, `onFix(fix: Fix): EngineEvent[]`, `selectManually(segmentId: string): Segment`, `get cursor(): number`, `get playedIds(): ReadonlySet<string>`

- [ ] **Step 1: Create the shared test fixture builder**

Create `src/lib/trigger/testFixtures.ts`:

```typescript
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
```

- [ ] **Step 2: Write the failing engine tests**

Create `src/lib/trigger/engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TriggerEngine } from './engine';
import { makeTour, makeSegment, STOP_COORDS, fixAt, eastOf } from './testFixtures';

describe('TriggerEngine — accuracy gating', () => {
  it('discards fixes with accuracy worse than the threshold', () => {
    const engine = new TriggerEngine(makeTour());
    // Sitting exactly on stop 0, but with 80 m of reported error.
    engine.onFix(fixAt(STOP_COORDS[0], 80));
    const events = engine.onFix(fixAt(STOP_COORDS[0], 80));
    expect(events).toHaveLength(0);
    expect(engine.cursor).toBe(0);
  });
});

describe('TriggerEngine — hysteresis', () => {
  it('does not fire on a single in-radius fix', () => {
    const engine = new TriggerEngine(makeTour());
    const events = engine.onFix(fixAt(STOP_COORDS[0], 10));
    expect(events).toHaveLength(0);
  });

  it('fires on the second consecutive in-radius fix', () => {
    const engine = new TriggerEngine(makeTour());
    engine.onFix(fixAt(STOP_COORDS[0], 10));
    const events = engine.onFix(fixAt(STOP_COORDS[0], 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'fire', segment: expect.objectContaining({ id: 'seg-0' }) });
    expect(engine.cursor).toBe(1);
  });

  it('resets the hit counter when the user leaves the radius', () => {
    const engine = new TriggerEngine(makeTour());
    engine.onFix(fixAt(STOP_COORDS[0], 10));
    engine.onFix(fixAt(eastOf(STOP_COORDS[0], 200), 10)); // wandered off
    const events = engine.onFix(fixAt(STOP_COORDS[0], 10)); // back, but only 1 hit
    expect(events).toHaveLength(0);
  });
});

describe('TriggerEngine — accuracy-adaptive radius', () => {
  it('widens the trigger radius to match poor GPS accuracy', () => {
    const engine = new TriggerEngine(makeTour());
    // 40 m from the stop: outside the 25 m base radius, but inside a 45 m
    // accuracy-adapted radius. This is the urban canyon case from spec §8.
    const p = eastOf(STOP_COORDS[0], 40);
    engine.onFix(fixAt(p, 45));
    const events = engine.onFix(fixAt(p, 45));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'fire' });
  });

  it('does not fire when outside even the widened radius', () => {
    const engine = new TriggerEngine(makeTour());
    const p = eastOf(STOP_COORDS[0], 60);
    engine.onFix(fixAt(p, 45));
    const events = engine.onFix(fixAt(p, 45));
    expect(events).toHaveLength(0);
  });
});

describe('TriggerEngine — ordering', () => {
  it('fires segments in order as the user walks the route', () => {
    const engine = new TriggerEngine(makeTour());
    const fired: string[] = [];

    for (const coord of STOP_COORDS) {
      engine.onFix(fixAt(coord, 10));
      for (const e of engine.onFix(fixAt(coord, 10))) {
        if (e.type === 'fire') fired.push(e.segment.id);
      }
    }

    expect(fired).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
  });

  it('allows skipping ahead within the lookahead window', () => {
    const engine = new TriggerEngine(makeTour());
    // Walk straight to stop 2 without visiting 0 or 1.
    engine.onFix(fixAt(STOP_COORDS[2], 10));
    const events = engine.onFix(fixAt(STOP_COORDS[2], 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'fire', segment: expect.objectContaining({ id: 'seg-2' }) });
    expect(engine.cursor).toBe(3);
  });

  it('does not fire a segment beyond the lookahead window', () => {
    const engine = new TriggerEngine(makeTour(), { lookahead: 1 });
    engine.onFix(fixAt(STOP_COORDS[3], 10));
    const events = engine.onFix(fixAt(STOP_COORDS[3], 10));
    expect(events).toHaveLength(0);
  });

  it('never re-fires a segment already played', () => {
    const engine = new TriggerEngine(makeTour());
    engine.onFix(fixAt(STOP_COORDS[0], 10));
    engine.onFix(fixAt(STOP_COORDS[0], 10)); // fires seg-0
    engine.onFix(fixAt(STOP_COORDS[1], 10));
    engine.onFix(fixAt(STOP_COORDS[1], 10)); // fires seg-1

    // Walk back to stop 0.
    engine.onFix(fixAt(STOP_COORDS[0], 10));
    const events = engine.onFix(fixAt(STOP_COORDS[0], 10));
    expect(events).toHaveLength(0);
  });
});

describe('TriggerEngine — non-triggered segments', () => {
  it('skips over intro and outro segments, which have no trigger', () => {
    const tour = makeTour({
      segments: [
        makeSegment(0, { id: 'intro', kind: 'intro', trigger: null }),
        makeSegment(0, { id: 'seg-0' }),
        makeSegment(1, { id: 'seg-1' }),
      ],
    });
    const engine = new TriggerEngine(tour);
    engine.onFix(fixAt(STOP_COORDS[0], 10));
    const events = engine.onFix(fixAt(STOP_COORDS[0], 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ segment: expect.objectContaining({ id: 'seg-0' }) });
  });
});

describe('TriggerEngine — manual selection', () => {
  it('returns the requested segment and marks it played', () => {
    const engine = new TriggerEngine(makeTour());
    const segment = engine.selectManually('seg-2');
    expect(segment.id).toBe('seg-2');
    expect(engine.playedIds.has('seg-2')).toBe(true);
  });

  it('advances the cursor past a manually selected segment', () => {
    const engine = new TriggerEngine(makeTour());
    engine.selectManually('seg-2');
    expect(engine.cursor).toBe(3);
  });

  it('throws for an unknown segment id', () => {
    const engine = new TriggerEngine(makeTour());
    expect(() => engine.selectManually('nope')).toThrow(/nope/);
  });
});

describe('TriggerEngine — off-route detection', () => {
  it('emits offRoute after the threshold distance is held for the duration', () => {
    const engine = new TriggerEngine(makeTour());
    const far = { lat: 52.3760, lng: 4.8912 }; // ~320 m north of the route

    engine.onFix(fixAt(far, 10, 1_000_000));
    const early = engine.onFix(fixAt(far, 10, 1_010_000)); // 10 s — too soon
    expect(early.some((e) => e.type === 'offRoute')).toBe(false);

    const late = engine.onFix(fixAt(far, 10, 1_035_000)); // 35 s — past threshold
    expect(late.some((e) => e.type === 'offRoute')).toBe(true);
  });

  it('emits offRoute only once until the user returns', () => {
    const engine = new TriggerEngine(makeTour());
    const far = { lat: 52.3760, lng: 4.8912 };

    engine.onFix(fixAt(far, 10, 1_000_000));
    engine.onFix(fixAt(far, 10, 1_035_000));
    const again = engine.onFix(fixAt(far, 10, 1_060_000));
    expect(again.some((e) => e.type === 'offRoute')).toBe(false);
  });

  it('emits backOnRoute when the user returns to the route', () => {
    const engine = new TriggerEngine(makeTour());
    const far = { lat: 52.3760, lng: 4.8912 };

    engine.onFix(fixAt(far, 10, 1_000_000));
    engine.onFix(fixAt(far, 10, 1_035_000)); // offRoute fires

    const back = engine.onFix(fixAt(STOP_COORDS[1], 10, 1_040_000));
    expect(back.some((e) => e.type === 'backOnRoute')).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test src/lib/trigger`
Expected: FAIL — `Failed to resolve import "./engine"`

- [ ] **Step 4: Implement the engine**

Create `src/lib/trigger/engine.ts`:

```typescript
import type { Segment, Tour } from '../../types/tour';
import type { Fix } from '../location/types';
import { haversineM, distanceToLineStringM } from '../geo';

export type EngineEvent =
  | { type: 'fire'; segment: Segment }
  | { type: 'offRoute'; distanceM: number }
  | { type: 'backOnRoute' };

export interface EngineConfig {
  /** Fixes with worse accuracy than this are discarded entirely. */
  maxAccuracyM: number;
  /** Consecutive in-radius fixes required before firing. */
  requiredHits: number;
  /** How many segments past the cursor may fire, allowing skip-ahead. */
  lookahead: number;
  /** Distance from the route line that counts as off-route. */
  offRouteThresholdM: number;
  /** How long the user must stay off-route before we say anything. */
  offRouteDurationMs: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  maxAccuracyM: 50,
  requiredHits: 2,
  lookahead: 2,
  offRouteThresholdM: 60,
  offRouteDurationMs: 30_000,
};

/**
 * Decides which narration segment should play, given a stream of GPS fixes.
 *
 * Deliberately free of I/O and React: `onFix` is a pure-ish state transition
 * returning the events its caller should act on. That is what makes the whole
 * thing testable against a synthetic fix sequence (see SimulatedLocation).
 */
export class TriggerEngine {
  private readonly tour: Tour;
  private readonly config: EngineConfig;

  private cursorIndex = 0;
  private hits = 0;
  private hitSegmentId: string | null = null;
  private played = new Set<string>();

  private offRouteSince: number | null = null;
  private offRouteAnnounced = false;

  constructor(tour: Tour, config: Partial<EngineConfig> = {}) {
    this.tour = tour;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get playedIds(): ReadonlySet<string> {
    return this.played;
  }

  onFix(fix: Fix): EngineEvent[] {
    // Urban canyons produce wildly inaccurate fixes. Acting on them causes
    // narration to fire streets away from the actual stop.
    if (fix.accuracyM > this.config.maxAccuracyM) return [];

    const events: EngineEvent[] = [];
    events.push(...this.evaluateOffRoute(fix));

    const candidate = this.findCandidate(fix);

    if (candidate === null) {
      this.hits = 0;
      this.hitSegmentId = null;
      return events;
    }

    // Restart the count if the user moved to a different candidate.
    if (this.hitSegmentId !== candidate.segment.id) {
      this.hitSegmentId = candidate.segment.id;
      this.hits = 0;
    }

    this.hits += 1;

    if (this.hits >= this.config.requiredHits) {
      this.played.add(candidate.segment.id);
      this.cursorIndex = candidate.index + 1;
      this.hits = 0;
      this.hitSegmentId = null;
      events.push({ type: 'fire', segment: candidate.segment });
    }

    return events;
  }

  /**
   * Play any segment on demand. This is the escape hatch that keeps the app
   * usable when GPS misbehaves — see spec §8.
   */
  selectManually(segmentId: string): Segment {
    const index = this.tour.segments.findIndex((s) => s.id === segmentId);
    if (index === -1) throw new Error(`Unknown segment id: ${segmentId}`);

    const segment = this.tour.segments[index];
    this.played.add(segment.id);
    if (index + 1 > this.cursorIndex) this.cursorIndex = index + 1;
    this.hits = 0;
    this.hitSegmentId = null;
    return segment;
  }

  /**
   * Finds the nearest segment within the lookahead window whose adapted
   * radius contains this fix.
   */
  private findCandidate(fix: Fix): { segment: Segment; index: number } | null {
    const end = Math.min(
      this.tour.segments.length,
      this.cursorIndex + this.config.lookahead + 1,
    );

    let best: { segment: Segment; index: number; distanceM: number } | null = null;

    for (let i = this.cursorIndex; i < end; i++) {
      const segment = this.tour.segments[i];
      if (segment.trigger === null) continue;
      if (this.played.has(segment.id)) continue;

      const distanceM = haversineM(fix, segment.trigger);
      // Widen the radius to the reported accuracy: a 25 m radius is
      // unreachable when the device only knows position to within 45 m.
      const radiusM = Math.max(segment.triggerRadiusM, fix.accuracyM);
      if (distanceM > radiusM) continue;

      if (best === null || distanceM < best.distanceM) {
        best = { segment, index: i, distanceM };
      }
    }

    return best === null ? null : { segment: best.segment, index: best.index };
  }

  private evaluateOffRoute(fix: Fix): EngineEvent[] {
    const distanceM = distanceToLineStringM(fix, this.tour.routeGeoJson);

    if (distanceM <= this.config.offRouteThresholdM) {
      const wasAnnounced = this.offRouteAnnounced;
      this.offRouteSince = null;
      this.offRouteAnnounced = false;
      return wasAnnounced ? [{ type: 'backOnRoute' }] : [];
    }

    if (this.offRouteSince === null) {
      this.offRouteSince = fix.timestamp;
      return [];
    }

    const elapsed = fix.timestamp - this.offRouteSince;
    if (elapsed >= this.config.offRouteDurationMs && !this.offRouteAnnounced) {
      this.offRouteAnnounced = true;
      return [{ type: 'offRoute', distanceM }];
    }

    return [];
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test src/lib/trigger`
Expected: PASS — 19 tests

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — 36 tests total

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add GPS trigger engine with hysteresis and adaptive radius"
```

---

### Task 4: Audio players

**Files:**
- Create: `src/lib/audio/types.ts`
- Create: `src/lib/audio/speechSynthesis.ts`
- Create: `src/lib/audio/htmlAudio.ts`
- Test: `src/lib/audio/speechSynthesis.test.ts`

**Interfaces:**
- Consumes: `Segment` from `src/types/tour.ts`
- Produces:
  - `AudioPlayer { unlock(): Promise<void>; play(segment: Segment): Promise<void>; stop(): void; isPlaying(): boolean }`
  - `SpeechSynthesisPlayer` — constructor `(lang: string)`
  - `HtmlAudioPlayer` — constructor `()`

Why two: `SpeechSynthesisPlayer` makes this plan demoable end-to-end with no backend and no TTS spend. `HtmlAudioPlayer` is what Plan 2 will use once real MP3s exist. Both satisfy the same interface, so the swap is one line.

- [ ] **Step 1: Define the interface**

Create `src/lib/audio/types.ts`:

```typescript
import type { Segment } from '../../types/tour';

export interface AudioPlayer {
  /**
   * Must be called from inside a user gesture handler. iOS Safari will not
   * allow programmatic playback until audio has been started once by a tap.
   */
  unlock(): Promise<void>;
  /** Resolves when the segment has finished playing or was stopped. */
  play(segment: Segment): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
}
```

- [ ] **Step 2: Write the failing speech-synthesis tests**

Create `src/lib/audio/speechSynthesis.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpeechSynthesisPlayer } from './speechSynthesis';
import type { Segment } from '../../types/tour';

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = '';
  constructor(public text: string) {}
}

function installFakeSpeech() {
  const spoken: FakeUtterance[] = [];
  const synth = {
    speak: vi.fn((u: FakeUtterance) => {
      spoken.push(u);
      // Finish on the next microtask so play() can be awaited.
      queueMicrotask(() => u.onend?.());
    }),
    cancel: vi.fn(),
    speaking: false,
  };
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  return { synth, spoken };
}

const segment: Segment = {
  id: 'seg-0',
  kind: 'stop',
  order: 0,
  title: 'Dam Square',
  script: 'You are standing on Dam Square.',
  audioUrl: null,
  durationMs: null,
  trigger: { lat: 52.3731, lng: 4.8936 },
  triggerRadiusM: 25,
  poiId: 'poi-0',
};

describe('SpeechSynthesisPlayer', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('speaks the segment script', async () => {
    const { spoken } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    await player.play(segment);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('You are standing on Dam Square.');
  });

  it('sets the utterance language', async () => {
    const { spoken } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('nl');
    await player.play(segment);
    expect(spoken[0].lang).toBe('nl');
  });

  it('reports isPlaying while speaking', async () => {
    installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    expect(player.isPlaying()).toBe(false);
    const pending = player.play(segment);
    expect(player.isPlaying()).toBe(true);
    await pending;
    expect(player.isPlaying()).toBe(false);
  });

  it('cancels any in-flight utterance on stop', async () => {
    const { synth } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    void player.play(segment);
    player.stop();
    expect(synth.cancel).toHaveBeenCalled();
    expect(player.isPlaying()).toBe(false);
  });

  it('cancels the previous segment when a new one starts', async () => {
    const { synth } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    void player.play(segment);
    await player.play({ ...segment, id: 'seg-1', script: 'Next stop.' });
    expect(synth.cancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test src/lib/audio`
Expected: FAIL — `Failed to resolve import "./speechSynthesis"`

- [ ] **Step 4: Implement SpeechSynthesisPlayer**

Create `src/lib/audio/speechSynthesis.ts`:

```typescript
import type { AudioPlayer } from './types';
import type { Segment } from '../../types/tour';

/**
 * Speaks narration with the browser's built-in voice.
 *
 * Robotic, and unusable as a shipping experience — but it needs no backend,
 * costs nothing, and lets the whole trigger-to-narration loop be demoed before
 * the generation pipeline exists. Replaced by HtmlAudioPlayer in Plan 2.
 */
export class SpeechSynthesisPlayer implements AudioPlayer {
  private playing = false;

  constructor(private readonly lang: string) {}

  async unlock(): Promise<void> {
    // speechSynthesis needs no gesture unlock, but some browsers stay silent
    // until the queue has been touched at least once from a user gesture.
    speechSynthesis.cancel();
  }

  play(segment: Segment): Promise<void> {
    speechSynthesis.cancel();

    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(segment.script);
      utterance.lang = this.lang;

      const finish = () => {
        this.playing = false;
        resolve();
      };

      utterance.onend = finish;
      utterance.onerror = finish;

      this.playing = true;
      speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    speechSynthesis.cancel();
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test src/lib/audio`
Expected: PASS — 11 tests (6 speech-synthesis, 5 HTML audio)

- [ ] **Step 6: Implement HtmlAudioPlayer**

Create `src/lib/audio/htmlAudio.ts`:

```typescript
import type { AudioPlayer } from './types';
import type { Segment } from '../../types/tour';

/**
 * Plays pre-generated MP3s through a single persistent <audio> element.
 *
 * The single-element design is deliberate: iOS Safari only permits
 * programmatic playback on an element that has already been played from a user
 * gesture. Creating a fresh element per segment would be blocked from the
 * second segment onward.
 */
export class HtmlAudioPlayer implements AudioPlayer {
  private readonly element: HTMLAudioElement;
  private playing = false;

  constructor() {
    this.element = new Audio();
    this.element.preload = 'auto';
  }

  async unlock(): Promise<void> {
    // A 1-sample silent WAV. Playing it inside a gesture marks the element as
    // user-activated for the rest of the session.
    this.element.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    try {
      await this.element.play();
    } catch {
      // Some browsers reject even the silent play; playback often still works.
    }
    this.element.pause();
  }

  play(segment: Segment): Promise<void> {
    if (segment.audioUrl === null) {
      return Promise.reject(new Error(`Segment ${segment.id} has no audioUrl`));
    }

    this.stop();

    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        this.playing = false;
        resolve();
      };
      const fail = () => {
        cleanup();
        this.playing = false;
        reject(new Error(`Playback failed for segment ${segment.id}`));
      };
      const cleanup = () => {
        this.element.removeEventListener('ended', finish);
        this.element.removeEventListener('error', fail);
      };

      this.element.addEventListener('ended', finish);
      this.element.addEventListener('error', fail);

      this.element.src = segment.audioUrl as string;
      this.playing = true;
      void this.element.play().catch(fail);
    });
  }

  stop(): void {
    this.element.pause();
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — 47 tests total

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add AudioPlayer interface with speech-synthesis and HTML audio implementations"
```

---

### Task 5: Fixture tour and player hook

**Files:**
- Create: `src/fixtures/amsterdam-tour.ts`
- Create: `src/hooks/useTourPlayer.ts`
- Test: `src/hooks/useTourPlayer.test.ts`

**Interfaces:**
- Consumes: `Tour`, `TriggerEngine`, `EngineEvent`, `LocationProvider`, `Fix`, `AudioPlayer`
- Produces:
  - `amsterdamTour: Tour`
  - `useTourPlayer(args: UseTourPlayerArgs): TourPlayerState` where
    `UseTourPlayerArgs = { tour: Tour; location: LocationProvider; audio: AudioPlayer }` and
    `TourPlayerState = { started: boolean; start(): Promise<void>; currentSegment: Segment | null; playedIds: ReadonlySet<string>; lastFix: Fix | null; offRoute: boolean; playSegment(id: string): void }`

The hook owns the queueing rule from spec §8: audio is never interrupted by a trigger, it is queued.

- [ ] **Step 1: Build the fixture tour**

Create `src/fixtures/amsterdam-tour.ts`:

```typescript
import type { Tour } from '../types/tour';

/**
 * A five-stop walk through central Amsterdam, hand-authored so the player can
 * be exercised before the generation pipeline exists. Coordinates are real;
 * narration is placeholder prose, not the product's voice.
 *
 * Spec §8 requires walk cues to fire on *departure* from a stop rather than on
 * arrival at the next one. That is achieved by placement, not by engine logic:
 * a 'walk' segment's trigger sits just past the preceding stop, so it fires as
 * the walker leaves. Plan 2's routing stage must preserve this convention when
 * it generates walk segments.
 */
export const amsterdamTour: Tour = {
  id: 'fixture-amsterdam-01',
  city: 'Amsterdam',
  language: 'en',
  persona: 'historian',
  title: 'Centre and Jordaan — a short loop',
  estimatedDurationMin: 35,
  routeGeoJson: {
    type: 'LineString',
    coordinates: [
      [4.8936, 52.3731],
      [4.8912, 52.3731],
      [4.8887, 52.3738],
      [4.884, 52.3747],
      [4.8843, 52.3789],
    ],
  },
  segments: [
    {
      id: 'intro',
      kind: 'intro',
      order: 0,
      title: 'Welcome',
      script:
        'Welcome to a short walk through the centre of Amsterdam. Keep your phone in hand, and I will start talking whenever we reach somewhere worth stopping.',
      audioUrl: null,
      durationMs: null,
      trigger: null,
      triggerRadiusM: 0,
      poiId: null,
    },
    {
      id: 'dam-square',
      kind: 'stop',
      order: 1,
      title: 'Dam Square',
      script:
        'You are standing on Dam Square, the spot the whole city grew out of. A dam was thrown across the river Amstel here in the thirteenth century, and the settlement that formed behind it took its name from the act: Amstel-dam.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3731, lng: 4.8936 },
      triggerRadiusM: 30,
      poiId: 'Q621594',
    },
    {
      id: 'walk-to-palace',
      kind: 'walk',
      order: 2,
      title: 'Toward the palace',
      script:
        'Carry on west across the square, keeping the large neoclassical building on your right.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3731, lng: 4.8924 },
      triggerRadiusM: 25,
      poiId: null,
    },
    {
      id: 'royal-palace',
      kind: 'stop',
      order: 3,
      title: 'Royal Palace',
      script:
        'This was never meant to be a palace. It opened in 1655 as Amsterdam’s city hall, at a moment when the city was arguably the richest in Europe, and it was built to say exactly that.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3731, lng: 4.8912 },
      triggerRadiusM: 30,
      poiId: 'Q224964',
    },
    {
      id: 'westerkerk',
      kind: 'stop',
      order: 4,
      title: 'Westerkerk',
      script:
        'The Westerkerk’s tower is the tallest in the city, and its bells are the ones Anne Frank wrote about hearing from the annexe a few doors along the canal.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3747, lng: 4.884 },
      triggerRadiusM: 30,
      poiId: 'Q1547588',
    },
    {
      id: 'noordermarkt',
      kind: 'stop',
      order: 5,
      title: 'Noordermarkt',
      script:
        'You have crossed into the Jordaan, built as a working district for the people who could not afford the canal belt behind you. The square holds a market on Saturdays that locals still actually use.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3789, lng: 4.8843 },
      triggerRadiusM: 30,
      poiId: 'Q2262940',
    },
    {
      id: 'outro',
      kind: 'outro',
      order: 6,
      title: 'That is the walk',
      script: 'That is the end of the loop. Thanks for walking it.',
      audioUrl: null,
      durationMs: null,
      trigger: null,
      triggerRadiusM: 0,
      poiId: null,
    },
  ],
};
```

- [ ] **Step 2: Write the failing hook test**

Create `src/hooks/useTourPlayer.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTourPlayer } from './useTourPlayer';
import { makeTour, STOP_COORDS, fixAt } from '../lib/trigger/testFixtures';
import type { Fix, FixListener, LocationProvider } from '../lib/location/types';
import type { AudioPlayer } from '../lib/audio/types';
import type { Segment } from '../types/tour';

class ManualLocation implements LocationProvider {
  private listener: FixListener | null = null;
  start(listener: FixListener) {
    this.listener = listener;
  }
  stop() {
    this.listener = null;
  }
  emit(fix: Fix) {
    this.listener?.(fix);
  }
}

class RecordingAudio implements AudioPlayer {
  played: Segment[] = [];
  private resolvers: Array<() => void> = [];
  private playing = false;

  async unlock() {}
  play(segment: Segment): Promise<void> {
    this.played.push(segment);
    this.playing = true;
    return new Promise<void>((resolve) => {
      this.resolvers.push(() => {
        this.playing = false;
        resolve();
      });
    });
  }
  stop() {
    this.playing = false;
    // Real players resolve their pending playback when cancelled — cancelling
    // speechSynthesis fires onend, and pausing an <audio> element ends the
    // wait. The fake must mirror that, or it hides interruption bugs.
    this.resolvers.shift()?.();
  }
  isPlaying() {
    return this.playing;
  }
  /** Finishes the oldest in-flight playback. */
  finishOne() {
    this.resolvers.shift()?.();
  }
}

describe('useTourPlayer', () => {
  it('plays a segment when the engine fires', async () => {
    const location = new ManualLocation();
    const audio = new RecordingAudio();
    const { result } = renderHook(() =>
      useTourPlayer({ tour: makeTour(), location, audio }),
    );

    await act(async () => {
      await result.current.start();
    });

    await act(async () => {
      location.emit(fixAt(STOP_COORDS[0], 10, 1_000_000));
      location.emit(fixAt(STOP_COORDS[0], 10, 1_001_000));
    });

    await waitFor(() => expect(audio.played.map((s) => s.id)).toEqual(['seg-0']));
  });

  it('queues rather than interrupting audio that is already playing', async () => {
    const location = new ManualLocation();
    const audio = new RecordingAudio();
    const { result } = renderHook(() =>
      useTourPlayer({ tour: makeTour(), location, audio }),
    );

    await act(async () => {
      await result.current.start();
    });

    // Fire seg-0, then immediately fire seg-1 while seg-0 is still playing.
    await act(async () => {
      location.emit(fixAt(STOP_COORDS[0], 10, 1_000_000));
      location.emit(fixAt(STOP_COORDS[0], 10, 1_001_000));
      location.emit(fixAt(STOP_COORDS[1], 10, 1_002_000));
      location.emit(fixAt(STOP_COORDS[1], 10, 1_003_000));
    });

    await waitFor(() => expect(audio.played.map((s) => s.id)).toEqual(['seg-0']));

    await act(async () => {
      audio.finishOne();
    });

    await waitFor(() =>
      expect(audio.played.map((s) => s.id)).toEqual(['seg-0', 'seg-1']),
    );
  });

  it('exposes the played set', async () => {
    const location = new ManualLocation();
    const audio = new RecordingAudio();
    const { result } = renderHook(() =>
      useTourPlayer({ tour: makeTour(), location, audio }),
    );

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      location.emit(fixAt(STOP_COORDS[0], 10, 1_000_000));
      location.emit(fixAt(STOP_COORDS[0], 10, 1_001_000));
    });

    await waitFor(() => expect(result.current.playedIds.has('seg-0')).toBe(true));
  });

  it('playSegment plays on demand', async () => {
    const location = new ManualLocation();
    const audio = new RecordingAudio();
    const { result } = renderHook(() =>
      useTourPlayer({ tour: makeTour(), location, audio }),
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.playSegment('seg-2');
    });

    await waitFor(() => expect(audio.played.map((s) => s.id)).toEqual(['seg-2']));
  });

  it('keeps the manual selection current after it interrupts playback', async () => {
    const location = new ManualLocation();
    const audio = new RecordingAudio();
    const { result } = renderHook(() =>
      useTourPlayer({ tour: makeTour(), location, audio }),
    );

    await act(async () => {
      await result.current.start();
    });

    await act(async () => {
      location.emit(fixAt(STOP_COORDS[0], 10, 1_000_000));
      location.emit(fixAt(STOP_COORDS[0], 10, 1_001_000));
    });
    await waitFor(() => expect(result.current.currentSegment?.id).toBe('seg-0'));

    // Interrupting resolves seg-0's pending play(). Without a generation
    // guard, that stale drain loop resumes, finds the queue empty and clears
    // currentSegment — blanking the bar while seg-2 is actually playing.
    await act(async () => {
      result.current.playSegment('seg-2');
    });

    await waitFor(() => expect(result.current.currentSegment?.id).toBe('seg-2'));

    // Give the stale loop every chance to misbehave before asserting again.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.currentSegment?.id).toBe('seg-2');
  });

  it('sets offRoute when the engine reports it', async () => {
    const location = new ManualLocation();
    const audio = new RecordingAudio();
    const { result } = renderHook(() =>
      useTourPlayer({ tour: makeTour(), location, audio }),
    );

    await act(async () => {
      await result.current.start();
    });

    const far = { lat: 52.376, lng: 4.8912 };
    await act(async () => {
      location.emit(fixAt(far, 10, 1_000_000));
      location.emit(fixAt(far, 10, 1_035_000));
    });

    await waitFor(() => expect(result.current.offRoute).toBe(true));
  });
});
```

- [ ] **Step 3: Install React testing dependencies**

```bash
npm install -D @testing-library/react @testing-library/dom
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test src/hooks`
Expected: FAIL — `Failed to resolve import "./useTourPlayer"`

- [ ] **Step 5: Implement the hook**

Create `src/hooks/useTourPlayer.ts`:

```typescript
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Segment, Tour } from '../types/tour';
import type { Fix, LocationProvider } from '../lib/location/types';
import type { AudioPlayer } from '../lib/audio/types';
import { TriggerEngine } from '../lib/trigger/engine';

export interface UseTourPlayerArgs {
  tour: Tour;
  location: LocationProvider;
  audio: AudioPlayer;
}

export interface TourPlayerState {
  started: boolean;
  /** Must be called from a user gesture — it unlocks audio playback. */
  start(): Promise<void>;
  currentSegment: Segment | null;
  playedIds: ReadonlySet<string>;
  lastFix: Fix | null;
  offRoute: boolean;
  playSegment(id: string): void;
}

export function useTourPlayer({
  tour,
  location,
  audio,
}: UseTourPlayerArgs): TourPlayerState {
  const engine = useMemo(() => new TriggerEngine(tour), [tour]);

  const [started, setStarted] = useState(false);
  const [currentSegment, setCurrentSegment] = useState<Segment | null>(null);
  const [playedIds, setPlayedIds] = useState<ReadonlySet<string>>(new Set());
  const [lastFix, setLastFix] = useState<Fix | null>(null);
  const [offRoute, setOffRoute] = useState(false);

  // Narration must never be cut off mid-sentence by the next trigger, so
  // segments queue behind whatever is playing (spec §8).
  const queue = useRef<Segment[]>([]);
  const draining = useRef(false);
  // Bumped whenever the queue is discarded out from under a running drain
  // loop. A loop whose generation is stale must not touch shared state — see
  // playSegment.
  const generation = useRef(0);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    const myGeneration = generation.current;

    while (queue.current.length > 0 && generation.current === myGeneration) {
      const next = queue.current.shift() as Segment;
      setCurrentSegment(next);
      try {
        await audio.play(next);
      } catch {
        // A failed segment should not stall the rest of the tour.
      }
    }

    // Only the newest loop owns the trailing state. A superseded loop exits
    // silently; clearing here would blank the segment its replacement is
    // already playing.
    if (generation.current === myGeneration) {
      draining.current = false;
      setCurrentSegment(null);
    }
  }, [audio]);

  const enqueue = useCallback(
    (segment: Segment) => {
      queue.current.push(segment);
      setPlayedIds(new Set(engine.playedIds));
      void drain();
    },
    [drain, engine],
  );

  const start = useCallback(async () => {
    await audio.unlock();
    setStarted(true);

    const intro = tour.segments.find((s) => s.kind === 'intro');
    if (intro) enqueue(intro);

    location.start((fix) => {
      setLastFix(fix);
      for (const event of engine.onFix(fix)) {
        if (event.type === 'fire') enqueue(event.segment);
        if (event.type === 'offRoute') setOffRoute(true);
        if (event.type === 'backOnRoute') setOffRoute(false);
      }
    });
  }, [audio, enqueue, engine, location, tour]);

  const playSegment = useCallback(
    (id: string) => {
      const segment = engine.selectManually(id);
      // A deliberate tap outranks whatever is playing. Automatic triggers
      // still queue (spec §8) — this interruption is user-initiated.
      generation.current += 1;
      audio.stop();
      queue.current = [];
      draining.current = false;
      enqueue(segment);
    },
    [audio, enqueue, engine],
  );

  useEffect(() => {
    return () => {
      location.stop();
      audio.stop();
    };
  }, [audio, location]);

  return { started, start, currentSegment, playedIds, lastFix, offRoute, playSegment };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test src/hooks`
Expected: PASS — 9 tests

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — 56 tests total

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Amsterdam fixture tour and useTourPlayer hook with audio queueing"
```

---

### Task 6: Map and player UI

**Files:**
- Create: `src/components/TourMap.tsx`
- Create: `src/components/NowPlaying.tsx`
- Create: `src/components/StopList.tsx`
- Modify: `src/App.tsx` (replace the Vite template contents entirely)
- Create: `.env.local.example`

**Interfaces:**
- Consumes: `TourPlayerState` from `src/hooks/useTourPlayer.ts`; `Tour`, `Segment`, `LatLng`; `Fix`
- Produces:
  - `<TourMap tour={Tour} lastFix={Fix | null} playedIds={ReadonlySet<string>} onSelectStop={(id: string) => void} />`
  - `<NowPlaying segment={Segment | null} offRoute={boolean} />`
  - `<StopList tour={Tour} playedIds={ReadonlySet<string>} currentId={string | null} onSelect={(id: string) => void} />`

These are visual components with no unit tests — they are verified by running the app in Task 8. The testable logic all lives in `src/lib/`.

- [ ] **Step 1: Add the Mapbox token config**

Create `.env.local.example`:

```
VITE_MAPBOX_TOKEN=pk.your_public_token_here
```

Append to `.gitignore`:

```
.env.local
```

Then create your own `.env.local` with a real token from https://account.mapbox.com/access-tokens/

- [ ] **Step 2: Build the map component**

Create `src/components/TourMap.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Tour } from '../types/tour';
import type { Fix } from '../lib/location/types';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

interface TourMapProps {
  tour: Tour;
  lastFix: Fix | null;
  playedIds: ReadonlySet<string>;
  onSelectStop: (id: string) => void;
}

export function TourMap({ tour, lastFix, playedIds, onSelectStop }: TourMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const stopMarkers = useRef<Map<string, mapboxgl.Marker>>(new Map());

  // Initialise the map once.
  useEffect(() => {
    if (map.current !== null || container.current === null) return;

    const start = tour.routeGeoJson.coordinates[0];
    map.current = new mapboxgl.Map({
      container: container.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: start,
      zoom: 15,
    });

    map.current.on('load', () => {
      const m = map.current;
      if (!m) return;

      m.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: tour.routeGeoJson },
      });
      m.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.75 },
      });

      for (const segment of tour.segments) {
        if (segment.trigger === null || segment.kind !== 'stop') continue;

        const el = document.createElement('button');
        el.className =
          'h-7 w-7 rounded-full border-2 border-white bg-blue-600 text-xs font-bold text-white shadow';
        el.textContent = String(segment.order);
        el.setAttribute('aria-label', `Play ${segment.title}`);
        el.addEventListener('click', () => onSelectStop(segment.id));

        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([segment.trigger.lng, segment.trigger.lat])
          .addTo(m);
        stopMarkers.current.set(segment.id, marker);
      }
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, [tour, onSelectStop]);

  // Follow the user.
  useEffect(() => {
    const m = map.current;
    if (!m || lastFix === null) return;

    if (userMarker.current === null) {
      const el = document.createElement('div');
      el.className = 'h-4 w-4 rounded-full border-2 border-white bg-red-500 shadow';
      userMarker.current = new mapboxgl.Marker({ element: el });
    }
    userMarker.current.setLngLat([lastFix.lng, lastFix.lat]).addTo(m);
    m.easeTo({ center: [lastFix.lng, lastFix.lat], duration: 700 });
  }, [lastFix]);

  // Grey out stops already visited.
  useEffect(() => {
    for (const [id, marker] of stopMarkers.current) {
      const el = marker.getElement();
      el.classList.toggle('bg-blue-600', !playedIds.has(id));
      el.classList.toggle('bg-slate-400', playedIds.has(id));
    }
  }, [playedIds]);

  return <div ref={container} className="h-full w-full" />;
}
```

- [ ] **Step 3: Build the now-playing bar**

Create `src/components/NowPlaying.tsx`:

```tsx
import type { Segment } from '../types/tour';

interface NowPlayingProps {
  segment: Segment | null;
  offRoute: boolean;
}

export function NowPlaying({ segment, offRoute }: NowPlayingProps) {
  if (offRoute) {
    return (
      <div className="bg-amber-500 px-4 py-3 text-sm font-medium text-white">
        You have wandered off the route. Head back to the blue line to carry on.
      </div>
    );
  }

  if (segment === null) {
    return (
      <div className="bg-slate-800 px-4 py-3 text-sm text-slate-300">
        Walking — narration will start when you reach the next stop.
      </div>
    );
  }

  return (
    <div className="bg-slate-900 px-4 py-3 text-white">
      <p className="text-xs uppercase tracking-wide text-slate-400">Now playing</p>
      <p className="text-base font-semibold">{segment.title}</p>
    </div>
  );
}
```

- [ ] **Step 4: Build the stop list**

Create `src/components/StopList.tsx`:

```tsx
import type { Tour } from '../types/tour';

interface StopListProps {
  tour: Tour;
  playedIds: ReadonlySet<string>;
  currentId: string | null;
  onSelect: (id: string) => void;
}

export function StopList({ tour, playedIds, currentId, onSelect }: StopListProps) {
  const stops = tour.segments.filter((s) => s.kind === 'stop');

  return (
    <ul className="divide-y divide-slate-200 overflow-y-auto">
      {stops.map((stop) => (
        <li key={stop.id}>
          <button
            onClick={() => onSelect(stop.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-100"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                currentId === stop.id
                  ? 'bg-emerald-600'
                  : playedIds.has(stop.id)
                    ? 'bg-slate-400'
                    : 'bg-blue-600'
              }`}
            >
              {stop.order}
            </span>
            <span className="text-sm font-medium text-slate-900">{stop.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Wire up App**

Replace `src/App.tsx` entirely:

```tsx
import { useMemo, useState } from 'react';
import { amsterdamTour } from './fixtures/amsterdam-tour';
import { useTourPlayer } from './hooks/useTourPlayer';
import { SimulatedLocation } from './lib/location/simulated';
import { SpeechSynthesisPlayer } from './lib/audio/speechSynthesis';
import { TourMap } from './components/TourMap';
import { NowPlaying } from './components/NowPlaying';
import { StopList } from './components/StopList';

export default function App() {
  const tour = amsterdamTour;

  const location = useMemo(
    () => new SimulatedLocation(tour.routeGeoJson, { intervalMs: 1000, accuracyM: 12, noiseM: 8 }),
    [tour],
  );
  const audio = useMemo(() => new SpeechSynthesisPlayer(tour.language), [tour]);

  const player = useTourPlayer({ tour, location, audio });
  const [starting, setStarting] = useState(false);

  if (!player.started) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-slate-900 px-8 text-center text-white">
        <h1 className="text-2xl font-semibold">{tour.title}</h1>
        <p className="text-sm text-slate-300">
          {tour.city} · about {tour.estimatedDurationMin} minutes
        </p>
        <button
          disabled={starting}
          onClick={async () => {
            setStarting(true);
            await player.start();
          }}
          className="rounded-full bg-blue-600 px-8 py-4 text-lg font-semibold disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start the walk'}
        </button>
        <p className="max-w-xs text-xs text-slate-400">
          Keep your phone in your hand with the screen on. Narration starts by itself as
          you arrive at each stop.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <div className="min-h-0 flex-1">
        <TourMap
          tour={tour}
          lastFix={player.lastFix}
          playedIds={player.playedIds}
          onSelectStop={player.playSegment}
        />
      </div>
      <NowPlaying segment={player.currentSegment} offRoute={player.offRoute} />
      <div className="max-h-56 shrink-0 bg-white">
        <StopList
          tour={tour}
          playedIds={player.playedIds}
          currentId={player.currentSegment?.id ?? null}
          onSelect={player.playSegment}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Verify it builds and the suite still passes**

Run: `npm run build && npm test`
Expected: build succeeds; 56 tests pass

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add map, now-playing bar and stop list UI"
```

---

### Task 7: Browser location, wake lock, and gesture unlock

**Files:**
- Create: `src/lib/location/browser.ts`
- Create: `src/hooks/useWakeLock.ts`
- Modify: `src/App.tsx`
- Test: `src/lib/location/browser.test.ts`

**Interfaces:**
- Consumes: `Fix`, `FixListener`, `LocationProvider`
- Produces:
  - `BrowserLocation` class implementing `LocationProvider`, constructor `()`
  - `useWakeLock(active: boolean): { supported: boolean; held: boolean }`

- [ ] **Step 1: Write the failing browser-location test**

Create `src/lib/location/browser.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserLocation } from './browser';
import type { Fix } from './types';

function installFakeGeolocation() {
  let nextId = 1;
  const watchers = new Map<number, (pos: unknown) => void>();

  const geolocation = {
    watchPosition: vi.fn((success: (pos: unknown) => void) => {
      const id = nextId++;
      watchers.set(id, success);
      return id;
    }),
    clearWatch: vi.fn((id: number) => watchers.delete(id)),
  };

  vi.stubGlobal('navigator', { geolocation });

  return {
    geolocation,
    emit(coords: { latitude: number; longitude: number; accuracy: number }, ts = 5000) {
      for (const w of watchers.values()) {
        w({ coords, timestamp: ts });
      }
    },
    watcherCount: () => watchers.size,
  };
}

describe('BrowserLocation', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('maps a GeolocationPosition to a Fix', () => {
    const fake = installFakeGeolocation();
    const fixes: Fix[] = [];
    const provider = new BrowserLocation();
    provider.start((f) => fixes.push(f));

    fake.emit({ latitude: 52.3731, longitude: 4.8936, accuracy: 14 }, 5000);

    expect(fixes).toEqual([
      { lat: 52.3731, lng: 4.8936, accuracyM: 14, timestamp: 5000 },
    ]);
  });

  it('requests high accuracy and disables caching', () => {
    const fake = installFakeGeolocation();
    new BrowserLocation().start(() => {});

    const options = fake.geolocation.watchPosition.mock.calls[0][2];
    expect(options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
  });

  it('clears the watch on stop', () => {
    const fake = installFakeGeolocation();
    const provider = new BrowserLocation();
    provider.start(() => {});
    expect(fake.watcherCount()).toBe(1);

    provider.stop();
    expect(fake.watcherCount()).toBe(0);
  });

  it('stop is safe to call before start', () => {
    installFakeGeolocation();
    expect(() => new BrowserLocation().stop()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/location/browser`
Expected: FAIL — `Failed to resolve import "./browser"`

- [ ] **Step 3: Implement BrowserLocation**

Create `src/lib/location/browser.ts`:

```typescript
import type { Fix, FixListener, LocationProvider } from './types';

/**
 * Real GPS via the Geolocation API.
 *
 * Only produces fixes while the page is foregrounded and visible — mobile
 * browsers suspend JavaScript when the screen locks. See spec §2; the fix for
 * that is a native shell, not a code change here.
 */
export class BrowserLocation implements LocationProvider {
  private watchId: number | null = null;

  start(listener: FixListener): void {
    this.stop();

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const fix: Fix = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          timestamp: position.timestamp,
        };
        listener(fix);
      },
      (error) => {
        console.warn('Geolocation error', error.code, error.message);
      },
      {
        enableHighAccuracy: true,
        // A cached fix from two minutes ago is worse than no fix — it will
        // trigger narration for a stop the user has already walked past.
        maximumAge: 0,
        timeout: 15_000,
      },
    );
  }

  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/lib/location/browser`
Expected: PASS — 4 tests

- [ ] **Step 5: Implement the wake lock hook**

Create `src/hooks/useWakeLock.ts`:

```typescript
import { useEffect, useState } from 'react';

/**
 * Holds a screen wake lock while `active` is true.
 *
 * Without this the screen sleeps mid-walk, JavaScript is suspended, and the
 * tour silently stops triggering. The lock is also re-acquired on visibility
 * change, because the browser releases it whenever the tab is hidden.
 */
export function useWakeLock(active: boolean): { supported: boolean; held: boolean } {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!supported || !active) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release();
          return;
        }
        setHeld(true);
        sentinel.addEventListener('release', () => setHeld(false));
      } catch {
        setHeld(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
      setHeld(false);
    };
  }, [active, supported]);

  return { supported, held };
}
```

- [ ] **Step 6: Switch App to real GPS with a simulation toggle**

In `src/App.tsx`, replace the `location` memo and add the wake lock. Change the imports at the top to add:

```tsx
import { BrowserLocation } from './lib/location/browser';
import { useWakeLock } from './hooks/useWakeLock';
```

Replace the `location` memo with:

```tsx
  // ?sim=1 in the URL runs the simulator instead of real GPS.
  const useSim = new URLSearchParams(window.location.search).has('sim');

  const location = useMemo(
    () =>
      useSim
        ? new SimulatedLocation(tour.routeGeoJson, {
            intervalMs: 1000,
            accuracyM: 12,
            noiseM: 8,
          })
        : new BrowserLocation(),
    [tour, useSim],
  );
```

Add immediately after the `useTourPlayer` call:

```tsx
  useWakeLock(player.started);
```

- [ ] **Step 7: Verify build and full suite**

Run: `npm run build && npm test`
Expected: build succeeds; 68 tests pass

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add real GPS provider, wake lock, and simulation toggle"
```

---

### Task 8: Dev panel, PWA shell, and manual verification

**Files:**
- Create: `src/components/DevPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `vite.config.ts`
- Create: `public/manifest.webmanifest`
- Create: `docs/TESTING.md`

**Interfaces:**
- Consumes: `SimulatedLocation` (its `setSpeed`, `pause`, `resume`, `jumpTo`, `injectFix` methods), `Tour`
- Produces: `<DevPanel sim={SimulatedLocation} tour={Tour} />`

- [ ] **Step 1: Build the dev panel**

Create `src/components/DevPanel.tsx`:

```tsx
import { useState } from 'react';
import type { SimulatedLocation } from '../lib/location/simulated';
import type { Tour } from '../types/tour';

interface DevPanelProps {
  sim: SimulatedLocation;
  tour: Tour;
}

/**
 * Runtime controls for the location simulator. Only rendered when the app is
 * started with ?sim=1. This is what makes the trigger engine iterable in
 * seconds rather than afternoons of walking around a city.
 */
export function DevPanel({ sim, tour }: DevPanelProps) {
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);

  const stops = tour.segments.filter((s) => s.trigger !== null);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute right-3 top-3 z-10 rounded bg-black/70 px-3 py-1.5 text-xs font-mono text-white"
      >
        dev
      </button>
    );
  }

  return (
    <div className="absolute right-3 top-3 z-10 w-60 space-y-3 rounded-lg bg-black/85 p-3 font-mono text-xs text-white">
      <div className="flex items-center justify-between">
        <span className="font-bold">Simulator</span>
        <button onClick={() => setOpen(false)} className="text-slate-400">
          close
        </button>
      </div>

      <label className="block">
        Speed: {speed}×
        <input
          type="range"
          min={1}
          max={20}
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpeed(v);
            sim.setSpeed(v);
          }}
          className="w-full"
        />
      </label>

      <button
        onClick={() => {
          if (paused) sim.resume();
          else sim.pause();
          setPaused(!paused);
        }}
        className="w-full rounded bg-slate-700 py-1.5"
      >
        {paused ? 'resume' : 'pause'}
      </button>

      <button
        onClick={() =>
          sim.injectFix({ lat: 0, lng: 0, accuracyM: 300, timestamp: Date.now() })
        }
        className="w-full rounded bg-amber-700 py-1.5"
        title="Should be discarded by the engine's accuracy gate"
      >
        inject bad fix
      </button>

      <div className="space-y-1">
        <span className="text-slate-400">jump to</span>
        {stops.map((stop, i) => (
          <button
            key={stop.id}
            onClick={() => sim.jumpTo(stops.length === 1 ? 0 : i / (stops.length - 1))}
            className="block w-full truncate rounded bg-slate-700 px-2 py-1 text-left"
          >
            {stop.title}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render the dev panel in App**

In `src/App.tsx`, add the import:

```tsx
import { DevPanel } from './components/DevPanel';
```

Inside the started-state return, wrap the map div so the panel can position over it — replace the map container block with:

```tsx
      <div className="relative min-h-0 flex-1">
        <TourMap
          tour={tour}
          lastFix={player.lastFix}
          playedIds={player.playedIds}
          onSelectStop={player.playSegment}
        />
        {useSim && <DevPanel sim={location as SimulatedLocation} tour={tour} />}
      </div>
```

- [ ] **Step 3: Add the PWA shell**

```bash
npm install -D vite-plugin-pwa
```

Update `vite.config.ts` to add the plugin:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'City Tours',
        short_name: 'Tours',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [],
      },
      workbox: {
        // Narration MP3s arrive in Plan 2; caching them makes tours work
        // without signal, which is common in dense old towns.
        runtimeCaching: [
          {
            urlPattern: /\.mp3$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tour-audio',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
```

- [ ] **Step 4: Write the manual test procedure**

Create `docs/TESTING.md`:

```markdown
# Manual testing

## Simulated walk (no walking required)

1. `npm run dev`
2. Open `http://localhost:5173/?sim=1` in a browser
3. Tap **Start the walk** — the intro narration should speak immediately
4. Open the `dev` panel, set speed to 10×
5. Expect, in order: Dam Square → toward the palace → Royal Palace →
   Westerkerk → Noordermarkt, each speaking on arrival
6. Tap **inject bad fix** — nothing should fire (the engine's accuracy gate
   discards it)
7. Tap a stop in the bottom list — it should play immediately, interrupting
   whatever is speaking
8. Use **jump to** to skip to Noordermarkt — it should fire without requiring
   the intermediate stops

## Real GPS on a phone

1. `npm run dev -- --host` and note the LAN address
2. Serve over HTTPS (geolocation requires a secure context) — `npx vite --https`
   or a tunnel such as `npx localtunnel --port 5173`
3. Open on the phone, tap **Start the walk**, grant location permission
4. Confirm the red dot tracks you and the map follows
5. Confirm the screen does not sleep while the tour is running
6. Walk to a stop and confirm narration fires within ~2 fixes of arrival

## Known limitations (spec §2)

- Locking the screen or backgrounding the tab suspends GPS. The tour will
  resume when you return, but will not have triggered while away.
- This is a platform limit, not a bug. The fix is the Capacitor shell.
```

- [ ] **Step 5: Verify build and full suite**

Run: `npm run build && npm test`
Expected: build succeeds; 68 tests pass

- [ ] **Step 6: Run the simulated walk end to end**

Follow `docs/TESTING.md` § Simulated walk. All eight checks must pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add dev simulator panel, PWA shell and manual test procedure"
```

---

## Definition of done

- [ ] `npm test` passes with 68 tests
- [ ] `npm run build` succeeds with no TypeScript errors
- [ ] The simulated walk in `docs/TESTING.md` completes all eight checks
- [ ] The app has been loaded on a real phone over HTTPS and tracked real GPS
- [ ] `src/lib/` contains no React imports
- [ ] No `any` in committed code

## What this plan deliberately does not build

Deferred to Plan 2 (Generation Pipeline):

- Wikidata / Wikipedia / OSM discovery
- Claude curation and narration
- Mapbox Directions routing
- Google Chirp 3 HD synthesis and MP3 storage
- The toponym pronunciation spike (spec §11.1) — it gates TTS integration, so it
  belongs at the head of Plan 2

Deferred to Plan 3 (Personalisation):

- Free-text input and extraction
- pgvector semantic cache
- Split hook / body / aside audio

Deferred indefinitely: accounts, payments, offline tour download UI, Capacitor
packaging, the remaining five languages.
