import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTourPlayer } from './useTourPlayer';
import { makeTour, STOP_COORDS, fixAt } from '../lib/trigger/testFixtures';
import type { Fix, FixListener, LocationProvider } from '../lib/location/types';
import type { AudioPlayer } from '../lib/audio/types';
import type { Segment } from '../types/tour';

class ManualLocation implements LocationProvider {
  /**
   * Every registered listener, not just the most recent one — a fake that
   * overwrites a single field on each start() call masks double-registration
   * bugs, since the second call would silently replace the first instead of
   * revealing that both are now live (as two independent setInterval loops
   * would be on the real SimulatedLocation).
   */
  listeners: FixListener[] = [];
  startCount = 0;
  start(listener: FixListener) {
    this.startCount += 1;
    this.listeners.push(listener);
  }
  stop() {
    this.listeners = [];
  }
  emit(fix: Fix) {
    for (const listener of this.listeners) listener(fix);
  }
}

/**
 * unlock() rejects on its first call, then succeeds on every call after —
 * enough to prove a failed unlock doesn't permanently disable start().
 */
class UnlockFailsOnceAudio implements AudioPlayer {
  played: Segment[] = [];
  private resolvers: Array<() => void> = [];
  private playing = false;
  private unlockShouldFail = true;

  async unlock() {
    if (this.unlockShouldFail) {
      this.unlockShouldFail = false;
      throw new Error('unlock failed');
    }
  }
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
    this.resolvers.shift()?.();
  }
  isPlaying() {
    return this.playing;
  }
}

/**
 * Throws synchronously on its first start() call — e.g. navigator.geolocation
 * being undefined on an insecure origin — then succeeds on every call after.
 */
class LocationThrowsOnce implements LocationProvider {
  listeners: FixListener[] = [];
  startCount = 0;
  private shouldThrow = true;
  start(listener: FixListener) {
    this.startCount += 1;
    if (this.shouldThrow) {
      this.shouldThrow = false;
      throw new Error('geolocation unavailable');
    }
    this.listeners.push(listener);
  }
  stop() {
    this.listeners = [];
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

    // The engine only accumulates off-route time across a realistic ~1 Hz
    // cadence (see engine.test.ts "does not announce offRoute across a long
    // gap"); a gap bigger than offRouteDurationMs resets its timer instead of
    // firing. So the fixture must emit fixes at roughly 1 Hz up to the 30 s
    // threshold, not two fixes far apart.
    const far = { lat: 52.376, lng: 4.8912 };
    await act(async () => {
      for (let t = 1_000_000; t <= 1_030_000; t += 1_000) {
        location.emit(fixAt(far, 10, t));
      }
    });

    await waitFor(() => expect(result.current.offRoute).toBe(true));
  });

  it('start() is idempotent: a double call registers the listener once and enqueues the intro once', async () => {
    const location = new ManualLocation();
    const audio = new RecordingAudio();
    // makeTour()'s fixture has no intro segment; build one so a double
    // enqueue would be observable.
    const introSegment: Segment = {
      id: 'intro',
      kind: 'intro',
      order: -1,
      title: 'Welcome',
      script: 'Welcome',
      audioUrl: null,
      durationMs: null,
      trigger: null,
      triggerRadiusM: 0,
      poiId: null,
    };
    const tour = makeTour({ segments: [introSegment, ...makeTour().segments] });
    const { result } = renderHook(() => useTourPlayer({ tour, location, audio }));

    // Simulate a double tap: both calls begin before either's audio.unlock()
    // has resolved, since setStarted(true) only runs after that await.
    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });

    expect(location.startCount).toBe(1);

    // If the intro had been enqueued twice, finishing the first play reveals
    // a second 'intro' play right behind it once the drain loop advances.
    await act(async () => {
      audio.finishOne();
      await Promise.resolve();
    });
    expect(audio.played.filter((s) => s.id === 'intro')).toHaveLength(1);
  });

  it('does not tear down the location listener or in-flight audio when the audio/location identity changes on re-render', async () => {
    const tour = makeTour();
    const location1 = new ManualLocation();
    const audio1 = new RecordingAudio();

    const { result, rerender } = renderHook(
      (props: { location: ManualLocation; audio: RecordingAudio }) =>
        useTourPlayer({ tour, location: props.location, audio: props.audio }),
      { initialProps: { location: location1, audio: audio1 } },
    );

    await act(async () => {
      await result.current.start();
    });

    await act(async () => {
      location1.emit(fixAt(STOP_COORDS[0], 10, 1_000_000));
      location1.emit(fixAt(STOP_COORDS[0], 10, 1_001_000));
    });
    await waitFor(() => expect(audio1.played.map((s) => s.id)).toEqual(['seg-0']));

    // A consumer that hasn't memoized its provider instances passes fresh
    // objects on every render. The hook must not go silently dead because of
    // that alone — that requires depending on [audio, location] in the
    // teardown effect, which is exactly the bug under test.
    const location2 = new ManualLocation();
    const audio2 = new RecordingAudio();
    await act(async () => {
      rerender({ location: location2, audio: audio2 });
    });

    // seg-0's playback must not have been cancelled purely by the identity
    // change.
    expect(audio1.isPlaying()).toBe(true);

    // The original location listener must still be live too.
    await act(async () => {
      location1.emit(fixAt(STOP_COORDS[1], 10, 1_002_000));
      location1.emit(fixAt(STOP_COORDS[1], 10, 1_003_000));
    });
    await act(async () => {
      audio1.finishOne();
    });
    await waitFor(() =>
      expect(audio1.played.map((s) => s.id)).toEqual(['seg-0', 'seg-1']),
    );
  });

  it('rolls back the start() guard when unlock() rejects, so a later start() still works', async () => {
    const location = new ManualLocation();
    const audio = new UnlockFailsOnceAudio();
    // makeTour()'s fixture has no intro segment; build one so a successful
    // second start() enqueueing it is observable.
    const introSegment: Segment = {
      id: 'intro',
      kind: 'intro',
      order: -1,
      title: 'Welcome',
      script: 'Welcome',
      audioUrl: null,
      durationMs: null,
      trigger: null,
      triggerRadiusM: 0,
      poiId: null,
    };
    const tour = makeTour({ segments: [introSegment, ...makeTour().segments] });
    const { result } = renderHook(() => useTourPlayer({ tour, location, audio }));

    // The first call's unlock() rejects. The caller must see that failure —
    // not have it silently swallowed — so it can surface an error.
    await act(async () => {
      await expect(result.current.start()).rejects.toThrow('unlock failed');
    });

    // Without a rollback, hasStarted stays permanently true after the first
    // (failed) call, so this second call would be silently swallowed by the
    // re-entrancy guard: no listener, no intro, no error, no started state.
    await act(async () => {
      await result.current.start();
    });

    expect(location.startCount).toBe(1);
    expect(audio.played.filter((s) => s.id === 'intro')).toHaveLength(1);
  });

  it('rolls back start() when location.start() throws, so the app is not started-but-dead and retry works', async () => {
    const location = new LocationThrowsOnce();
    const audio = new RecordingAudio();
    const { result } = renderHook(() =>
      useTourPlayer({ tour: makeTour(), location, audio }),
    );

    await act(async () => {
      await expect(result.current.start()).rejects.toThrow('geolocation unavailable');
    });

    // Must not be left started-but-dead: `started` flipping true before the
    // throw would leave the entry screen gone and no live GPS listener, with
    // no way back short of remounting.
    expect(result.current.started).toBe(false);

    // A second start() must actually retry location.start() rather than being
    // silently swallowed by hasStarted staying permanently true.
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.started).toBe(true);
    expect(location.startCount).toBe(2);
    expect(location.listeners).toHaveLength(1);
  });

  describe('outro', () => {
    const outroSegment: Segment = {
      id: 'outro',
      kind: 'outro',
      order: 99,
      title: 'That is the walk',
      script: 'Thanks for walking it.',
      audioUrl: null,
      durationMs: null,
      trigger: null,
      triggerRadiusM: 0,
      poiId: null,
    };

    it('enqueues the outro once every triggerable segment has played, and only once', async () => {
      const location = new ManualLocation();
      const audio = new RecordingAudio();
      const tour = makeTour({ segments: [...makeTour().segments, outroSegment] });
      const { result } = renderHook(() => useTourPlayer({ tour, location, audio }));

      await act(async () => {
        await result.current.start();
      });

      // Walk every stop in order, two consecutive hits each (requiredHits: 2).
      let t = 1_000_000;
      await act(async () => {
        for (const coord of STOP_COORDS) {
          location.emit(fixAt(coord, 10, t));
          t += 1000;
          location.emit(fixAt(coord, 10, t));
          t += 1000;
        }
      });

      // Drain the queue: seg-0, seg-1, seg-2, seg-3, then the outro.
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          audio.finishOne();
        });
      }

      await waitFor(() =>
        expect(audio.played.map((s) => s.id)).toEqual([
          'seg-0',
          'seg-1',
          'seg-2',
          'seg-3',
          'outro',
        ]),
      );

      // Further fixes at the final stop's coordinates must not re-fire the
      // outro — it already played once.
      await act(async () => {
        location.emit(fixAt(STOP_COORDS[3], 10, t));
        t += 1000;
        location.emit(fixAt(STOP_COORDS[3], 10, t));
        await Promise.resolve();
      });

      expect(audio.played.filter((s) => s.id === 'outro')).toHaveLength(1);
    });

    it('does not fire the outro when a walker skips ahead without playing every stop', async () => {
      const location = new ManualLocation();
      const audio = new RecordingAudio();
      const tour = makeTour({ segments: [...makeTour().segments, outroSegment] });
      const { result } = renderHook(() => useTourPlayer({ tour, location, audio }));

      await act(async () => {
        await result.current.start();
      });

      // A deliberate tap jumps straight to the last stop, skipping seg-1 and
      // seg-2 — a walker who skips ahead has not finished the tour.
      act(() => {
        result.current.playSegment('seg-3');
      });

      await waitFor(() => expect(audio.played.map((s) => s.id)).toEqual(['seg-3']));

      // Give any pending microtasks every chance to (wrongly) queue the outro.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(audio.played.some((s) => s.id === 'outro')).toBe(false);
    });
  });
});
