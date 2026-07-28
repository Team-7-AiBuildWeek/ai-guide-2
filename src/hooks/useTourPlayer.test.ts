import { describe, it, expect } from 'vitest';
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
});
