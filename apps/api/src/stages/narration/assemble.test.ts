// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TourSchema,
  type CuratedStop,
  type GenerateRequest,
  type NarrationOutput,
} from '@ai-guide/shared';
import type { RouteResult } from '../routing/index.ts';
import { speakingSeconds, DWELL_SECONDS, route } from '../routing/index.ts';
import { createRedactingCassetteFetch } from '../routing/mapbox.ts';
import { FileCassetteStore } from '../../cassette/index.ts';
import { assembleTour } from './assemble.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', '..', '..', 'cassettes');
const fixturePath = join(here, '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'fixtures', 'bratislava-tour.json');

function makeRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    city: 'Bratislava',
    profileText: 'brutalist architecture',
    language: 'sk',
    persona: 'a grumpy local historian',
    budgetMin: 90,
    ...overrides,
  };
}

function makeStops(n: number): CuratedStop[] {
  return Array.from({ length: n }, (_, i) => ({
    wikidataQids: [`Q${1000 + i}`],
    standingPoint: { lat: 48.14 + i * 0.001, lng: 17.1 + i * 0.001 },
    title: `Stop ${i}`,
    why: 'x',
    order: i,
  }));
}

function makeRoute(legCount: number): RouteResult {
  const legs = Array.from({ length: legCount }, (_, i) => ({ distanceM: 200 + i * 10, durationS: 150 + i * 5 }));
  return {
    line: {
      type: 'LineString',
      coordinates: Array.from({ length: legCount + 1 }, (_, i) => [17.1 + i * 0.001, 48.14 + i * 0.001] as [number, number]),
    },
    legs,
    walkCuePoints: legs.map((_, i) => ({ lat: 48.1405 + i * 0.001, lng: 17.1005 + i * 0.001 })),
    triggerRadiiM: Array.from({ length: legCount + 1 }, (_, i) => 30 + i * 5),
    estimatedMin: 90,
    overBudget: false,
  };
}

function makeNarration(n: number): NarrationOutput {
  const segments: NarrationOutput['segments'] = [];
  let order = 0;
  segments.push({ order: order++, kind: 'intro', title: 'Intro', script: 'x'.repeat(200) });
  for (let i = 0; i < n; i++) {
    segments.push({ order: order++, kind: 'stop', title: `Stop ${i}`, script: 'x'.repeat(500 + i * 10) });
    if (i < n - 1) {
      segments.push({ order: order++, kind: 'walk', title: `Walk ${i}`, script: 'x'.repeat(150) });
    }
  }
  segments.push({ order: order++, kind: 'outro', title: 'Outro', script: 'x'.repeat(200) });
  return { segments };
}

function assemble(n: number) {
  const stops = makeStops(n);
  const route = makeRoute(n - 1);
  const narration = makeNarration(n);
  const tour = assembleTour({
    tourId: 'tour-1',
    tourTitle: 'Test Tour',
    city: 'Bratislava',
    request: makeRequest(),
    stops,
    route,
    narration,
  });
  return { tour, stops, route, narration };
}

describe('assembleTour', () => {
  it('produces segments in ascending order starting from 0', () => {
    const { tour } = assemble(4);
    expect(tour.segments.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('gives intro and outro a null trigger', () => {
    const { tour } = assemble(3);
    const intro = tour.segments.find((s) => s.kind === 'intro')!;
    const outro = tour.segments.find((s) => s.kind === 'outro')!;
    expect(intro.trigger).toBeNull();
    expect(outro.trigger).toBeNull();
  });

  it("sets each stop's trigger to its standing point and radius from route.triggerRadiiM", () => {
    const { tour, stops, route } = assemble(3);
    const stopSegments = tour.segments.filter((s) => s.kind === 'stop');
    expect(stopSegments).toHaveLength(3);
    stopSegments.forEach((seg, i) => {
      expect(seg.trigger).toEqual(stops[i].standingPoint);
      expect(seg.triggerRadiusM).toBe(route.triggerRadiiM[i]);
    });
  });

  it("sets each walk segment's trigger to the corresponding walkCuePoint", () => {
    const { tour, route } = assemble(3);
    const walkSegments = tour.segments.filter((s) => s.kind === 'walk');
    expect(walkSegments).toHaveLength(2);
    walkSegments.forEach((seg, i) => {
      expect(seg.trigger).toEqual(route.walkCuePoints[i]);
    });
  });

  it('gives each walk segment the SAME derived radius as the stop it departs from', () => {
    const { tour, route } = assemble(3);
    const walkSegments = tour.segments.filter((s) => s.kind === 'walk');
    // Walk 0 departs from stop 0, walk 1 departs from stop 1.
    expect(walkSegments[0].triggerRadiusM).toBe(route.triggerRadiiM[0]);
    expect(walkSegments[1].triggerRadiusM).toBe(route.triggerRadiiM[1]);
  });

  it("sets poiIds to the stop's wikidataQids for stop segments, and [] otherwise", () => {
    const { tour, stops } = assemble(3);
    const stopSegments = tour.segments.filter((s) => s.kind === 'stop');
    stopSegments.forEach((seg, i) => {
      expect(seg.poiIds).toEqual(stops[i].wikidataQids);
    });
    for (const seg of tour.segments.filter((s) => s.kind !== 'stop')) {
      expect(seg.poiIds).toEqual([]);
    }
  });

  it('sets audioUrl and durationMs to null on every segment', () => {
    const { tour } = assemble(3);
    for (const seg of tour.segments) {
      expect(seg.audioUrl).toBeNull();
      expect(seg.durationMs).toBeNull();
    }
  });

  it("sets routeGeoJson to route.line", () => {
    const { tour, route } = assemble(3);
    expect(tour.routeGeoJson).toEqual(route.line);
  });

  it('carries the requested language and persona, and the given city/title/id', () => {
    const { tour } = assemble(3);
    expect(tour.id).toBe('tour-1');
    expect(tour.title).toBe('Test Tour');
    expect(tour.city).toBe('Bratislava');
    expect(tour.language).toBe('sk');
    expect(tour.persona).toBe('a grumpy local historian');
  });

  it('recomputes estimatedDurationMin from the ACTUAL scripts, not a placeholder', () => {
    const { tour, route, narration } = assemble(3);

    const totalLegDurationS = route.legs.reduce((s, l) => s + l.durationS, 0);
    const totalDwellS = narration.segments
      .filter((s) => s.kind === 'stop')
      .reduce((sum, s) => sum + DWELL_SECONDS + speakingSeconds(s.script), 0);
    const expectedMin = (totalLegDurationS + totalDwellS) / 60;

    expect(tour.estimatedDurationMin).toBeCloseTo(expectedMin, 6);
  });

  it('produces a Tour that parses against TourSchema', () => {
    const { tour } = assemble(4);
    const result = TourSchema.safeParse(tour);
    expect(result.success).toBe(true);
  });

  it('assigns each segment a unique id', () => {
    const { tour } = assemble(4);
    const ids = tour.segments.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces exactly the checked-in packages/shared/src/fixtures/bratislava-tour.json fixture', async () => {
    // This is the reproducibility contract for the cross-workspace fixture:
    // apps/web/src/lib/trigger/assembledTour.test.ts drives the REAL
    // TriggerEngine with that static fixture (apps/web cannot import
    // apps/api directly — see task-8-report.md). This test is what stops
    // that fixture from silently drifting from what assembleTour() actually
    // produces: if either changes, this assertion catches it, and the
    // fixture must be regenerated with
    // apps/api/scripts/generate-tour-fixture.ts.
    const curationRaw = await readFile(join(cassetteDir, 'synthetic', 'curation-bratislava.json'), 'utf8');
    const curationCassette = JSON.parse(curationRaw) as { tourTitle: string; stops: CuratedStop[] };

    const narrationRaw = await readFile(join(cassetteDir, 'synthetic', 'narration-bratislava-sk.json'), 'utf8');
    const narrationCassette = JSON.parse(narrationRaw) as NarrationOutput;

    const unusedLive: typeof fetch = async () => {
      throw new Error('replay must never call through to a live fetch');
    };
    const store = new FileCassetteStore(cassetteDir);
    const routeFetch = createRedactingCassetteFetch('replay', store, unusedLive);
    const routeResult = await route(curationCassette.stops, 90, { fetch: routeFetch, token: 'unused-in-replay' });

    const tour = assembleTour({
      tourId: 'bratislava-castle-to-old-town-sk',
      tourTitle: curationCassette.tourTitle,
      city: 'Bratislava',
      request: {
        city: 'Bratislava',
        profileText: 'brutalist architecture, and I hate crowds',
        language: 'sk',
        persona: 'a grumpy local historian',
        budgetMin: 90,
      },
      stops: curationCassette.stops,
      route: routeResult,
      narration: { segments: narrationCassette.segments },
    });

    const fixtureRaw = await readFile(fixturePath, 'utf8');
    const fixture = JSON.parse(fixtureRaw) as { _generated: boolean; tour: unknown };

    expect(fixture._generated).toBe(true);
    expect(tour).toEqual(fixture.tour);
  });

  it('throws if the narration segment count does not match 2N+1 for the given stops', () => {
    const stops = makeStops(3);
    const route = makeRoute(2);
    const narration = makeNarration(4); // wrong stop count vs. the 3 curated stops

    expect(() =>
      assembleTour({
        tourId: 'tour-1',
        tourTitle: 'Test Tour',
        city: 'Bratislava',
        request: makeRequest(),
        stops,
        route,
        narration,
      }),
    ).toThrow(/expected/i);
  });
});
