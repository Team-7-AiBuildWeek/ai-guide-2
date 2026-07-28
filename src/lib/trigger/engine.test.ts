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

  it('does not announce offRoute across a long gap of discarded fixes', () => {
    const engine = new TriggerEngine(makeTour());
    const far = { lat: 52.3760, lng: 4.8912 };

    engine.onFix(fixAt(far, 10, 1_000_000)); // first off-route observation

    // Urban canyon: every fix over the next ~10 minutes is too inaccurate to
    // use and is discarded before it ever reaches off-route evaluation.
    engine.onFix(fixAt(far, 80, 1_100_000));
    engine.onFix(fixAt(far, 80, 1_300_000));

    // GPS recovers long after the last valid observation. A single fresh
    // sample should not retroactively count the whole silent gap as time
    // spent off-route.
    const events = engine.onFix(fixAt(far, 10, 1_700_000));
    expect(events.some((e) => e.type === 'offRoute')).toBe(false);
  });
});
