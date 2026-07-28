import { describe, it, expect } from 'vitest';
import { TriggerEngine } from './engine';
import { makeTour, makeSegment, STOP_COORDS, fixAt, eastOf, tourWithStopsAt } from './testFixtures';

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

describe('TriggerEngine — co-located stops', () => {
  it('fires when two stops are simultaneously in range and the nearest flips', () => {
    const tour = tourWithStopsAt([
      { id: 'a', lat: 48.1436, lng: 17.1085 },
      { id: 'b', lat: 48.1441, lng: 17.1085 }, // ~56m north
    ]);
    const engine = new TriggerEngine(tour, { requiredHits: 2 });

    // Both stops sit inside a 50m-accuracy radius from a point between them.
    const base = { lng: 17.1085, accuracyM: 50 };
    const nearerA = { ...base, lat: 48.14370 };
    const nearerB = { ...base, lat: 48.14400 };

    expect(engine.onFix({ ...nearerA, timestamp: 1000 })).toEqual([]);
    const events = engine.onFix({ ...nearerB, timestamp: 2000 });

    // Before the fix: hitSegmentId flips, hits resets, nothing ever fires.
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(1);
  });

  it('does not fire a segment that left the radius before reaching the threshold', () => {
    const tour = tourWithStopsAt([{ id: 'a', lat: 48.1436, lng: 17.1085 }]);
    const engine = new TriggerEngine(tour, { requiredHits: 2 });

    engine.onFix({ lat: 48.1436, lng: 17.1085, accuracyM: 20, timestamp: 1000 });
    // ~500m away: out of range, so the streak must be discarded, not held.
    engine.onFix({ lat: 48.1481, lng: 17.1085, accuracyM: 20, timestamp: 2000 });
    const events = engine.onFix({ lat: 48.1436, lng: 17.1085, accuracyM: 20, timestamp: 3000 });

    expect(events.filter((e) => e.type === 'fire')).toHaveLength(0);
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

  it('fires a skipped-over segment when the walker returns to it', () => {
    const engine = new TriggerEngine(makeTour());

    // Skip straight to stop 2, jumping over stops 0 and 1.
    engine.onFix(fixAt(STOP_COORDS[2], 10));
    engine.onFix(fixAt(STOP_COORDS[2], 10)); // fires seg-2, cursor -> 3

    // Walk back to stop 1, which was passed over and never played.
    engine.onFix(fixAt(STOP_COORDS[1], 10));
    const events = engine.onFix(fixAt(STOP_COORDS[1], 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'fire',
      segment: expect.objectContaining({ id: 'seg-1' }),
    });
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
  const far = { lat: 52.3760, lng: 4.8912 }; // ~320 m north of the route
  const START = 1_000_000;

  it('emits offRoute after the threshold distance is held for the duration', () => {
    const engine = new TriggerEngine(makeTour());

    // Realistic ~1 Hz GPS cadence, continuously off-route.
    const fireTimestamps: number[] = [];
    for (let t = START; t <= START + 34_000; t += 1_000) {
      const events = engine.onFix(fixAt(far, 10, t));
      if (events.some((e) => e.type === 'offRoute')) fireTimestamps.push(t);
    }

    // Nothing should have fired before the 30 s threshold, and exactly one
    // event should have fired at or after it.
    expect(fireTimestamps).toHaveLength(1);
    expect(fireTimestamps[0] - START).toBeGreaterThanOrEqual(30_000);
  });

  it('emits offRoute only once until the user returns', () => {
    const engine = new TriggerEngine(makeTour());

    let fireCount = 0;
    for (let t = START; t <= START + 60_000; t += 1_000) {
      const events = engine.onFix(fixAt(far, 10, t));
      fireCount += events.filter((e) => e.type === 'offRoute').length;
    }

    // Still off-route a further 30 s past the original announcement — must
    // not announce a second time.
    expect(fireCount).toBe(1);
  });

  it('emits backOnRoute when the user returns to the route', () => {
    const engine = new TriggerEngine(makeTour());

    let t = START;
    for (; t <= START + 30_000; t += 1_000) {
      engine.onFix(fixAt(far, 10, t)); // drives past the announcement threshold
    }

    // One more 1 Hz sample, back on the route.
    const back = engine.onFix(fixAt(STOP_COORDS[1], 10, t));
    expect(back.some((e) => e.type === 'backOnRoute')).toBe(true);
  });

  it('does not announce offRoute across a long gap with no fixes at all', () => {
    const engine = new TriggerEngine(makeTour());

    // A few 1 Hz off-route samples, well short of the 30 s threshold.
    engine.onFix(fixAt(far, 10, START));
    engine.onFix(fixAt(far, 10, START + 1_000));
    engine.onFix(fixAt(far, 10, START + 2_000));

    // Then nothing at all for ten minutes — e.g. the tab was backgrounded —
    // before a single fresh off-route fix arrives. The gap alone, with no
    // discarded fixes in it, must be enough to restart the timer: a single
    // sample after a silent gap this long cannot be "sustained" off-route
    // observation.
    const tenMinutesLater = START + 2_000 + 10 * 60_000;
    const events = engine.onFix(fixAt(far, 10, tenMinutesLater));
    expect(events.some((e) => e.type === 'offRoute')).toBe(false);
  });
});
