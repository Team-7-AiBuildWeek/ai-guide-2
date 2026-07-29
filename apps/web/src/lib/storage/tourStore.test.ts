import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { TourSchema, type LineString, type Tour } from '@ai-guide/shared';
import { saveTour, loadTour, loadLatest, clear } from './tourStore';

const FAKE_LINE: LineString = { type: 'LineString', coordinates: [[17.1, 48.14]] };

function makeTour(id: string): Tour {
  return {
    id,
    city: 'Bratislava',
    language: 'en',
    persona: 'a grumpy local historian',
    profileText: 'brutalist architecture',
    title: `Tour ${id}`,
    segments: [
      {
        id: 'seg-1',
        kind: 'intro',
        order: 0,
        title: 'Welcome',
        script: 'Welcome to the walk.',
        audioUrl: null,
        durationMs: null,
        trigger: null,
        triggerRadiusM: 20,
        poiIds: [],
      },
    ],
    routeGeoJson: FAKE_LINE,
    estimatedDurationMin: 42,
  };
}

describe('tourStore', () => {
  // A fresh IDBFactory per test isolates each test's data — reusing one
  // instance across tests would leak tours between them and make ordering
  // assertions (loadLatest) flaky depending on run order.
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  it('round-trips a tour, and TourSchema.parse succeeds on the way out', async () => {
    const tour = makeTour('tour-1');
    await saveTour(tour);

    const loaded = await loadTour('tour-1');

    expect(loaded).toEqual(tour);
    expect(() => TourSchema.parse(loaded)).not.toThrow();
  });

  it('returns null for a tour that was never saved', async () => {
    expect(await loadTour('does-not-exist')).toBeNull();
  });

  it('loadLatest returns null when nothing has been saved', async () => {
    expect(await loadLatest()).toBeNull();
  });

  it('loadLatest returns the most recently saved tour', async () => {
    await saveTour(makeTour('tour-1'));
    // Distinguish save order even if Date.now() resolution ties on a fast
    // machine.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveTour(makeTour('tour-2'));

    const latest = await loadLatest();
    expect(latest?.id).toBe('tour-2');
  });

  it('clear removes every stored tour', async () => {
    await saveTour(makeTour('tour-1'));
    await saveTour(makeTour('tour-2'));

    await clear();

    expect(await loadLatest()).toBeNull();
    expect(await loadTour('tour-1')).toBeNull();
  });

  it('saveTour overwrites a tour with the same id', async () => {
    await saveTour(makeTour('tour-1'));
    const updated = { ...makeTour('tour-1'), title: 'Updated title' };
    await saveTour(updated);

    const loaded = await loadTour('tour-1');
    expect(loaded?.title).toBe('Updated title');
  });
});
