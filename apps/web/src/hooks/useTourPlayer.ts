import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Segment, Tour } from '@ai-guide/shared';
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
  /** Must be called from a user gesture â€” it unlocks audio playback. */
  start(): Promise<void>;
  currentSegment: Segment | null;
  playedIds: ReadonlySet<string>;
  lastFix: Fix | null;
  offRoute: boolean;
  playSegment(id: string): void;
  /**
   * Freezes the guide's voice without stopping the walk: GPS keeps firing,
   * triggered segments queue up behind the frozen one, and resume() picks up
   * mid-sentence where pause left it. A manual playSegment() tap lifts the
   * pause — a deliberate "play this" outranks a standing "be quiet".
   */
  paused: boolean;
  pause(): void;
  resume(): void;
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
  const [paused, setPaused] = useState(false);

  // Narration must never be cut off mid-sentence by the next trigger, so
  // segments queue behind whatever is playing (spec Â§8).
  const queue = useRef<Segment[]>([]);
  const draining = useRef(false);
  // Bumped whenever the queue is discarded out from under a running drain
  // loop. A loop whose generation is stale must not touch shared state â€” see
  // playSegment.
  const generation = useRef(0);
  // Guards start() against re-entrancy. A `started` state check would still
  // be racy: two calls can both read `started === false` before either
  // write lands, since setStarted(true) only runs after `await
  // audio.unlock()` resolves. This ref is set synchronously before that
  // await, closing the window a double tap could slip through.
  const hasStarted = useRef(false);

  // Kept current on every render so the unmount-only cleanup effect below
  // always stops whatever provider is actually in use, without the effect
  // needing to depend on audio/location identity (see that effect).
  const audioRef = useRef(audio);
  const locationRef = useRef(location);
  audioRef.current = audio;
  locationRef.current = location;

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

  // Fires the outro once every triggerable segment (every segment with a
  // real trigger coordinate â€” i.e. every stop and walk cue) has played. Not
  // a new state machine: just a completion check against the engine's own
  // played set, run after anything that could complete the tour. Guarded by
  // that same set so it can only ever enqueue once, and it deliberately does
  // NOT trigger on reaching the last stop by position or index â€” a walker
  // who skipped ahead over an earlier stop has not finished, since that
  // earlier stop's id is still missing from playedIds.
  const maybeEnqueueOutro = useCallback(() => {
    const outro = tour.segments.find((s) => s.kind === 'outro');
    if (!outro) return;
    if (engine.playedIds.has(outro.id)) return;

    const triggerable = tour.segments.filter((s) => s.trigger !== null);
    const allPlayed = triggerable.every((s) => engine.playedIds.has(s.id));
    if (!allPlayed) return;

    // selectManually adds outro.id to the engine's played set as a side
    // effect, which is what makes the guard above prevent a second fire.
    engine.selectManually(outro.id);
    enqueue(outro);
  }, [tour, engine, enqueue]);

  const start = useCallback(async () => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    try {
      await audio.unlock();
    } catch (err) {
      // unlock() carries no never-rejects guarantee (unlike play()). If it
      // throws, roll the guard back so the hook is startable again â€” leaving
      // it permanently true would brick the start button for the rest of
      // the hook's life after a single failed unlock, with no recovery short
      // of remounting. Re-throw rather than swallow: the caller needs to
      // know the unlock failed so it can surface an error.
      hasStarted.current = false;
      throw err;
    }
    setStarted(true);

    const intro = tour.segments.find((s) => s.kind === 'intro');
    if (intro) enqueue(intro);

    try {
      location.start((fix) => {
        setLastFix(fix);
        for (const event of engine.onFix(fix)) {
          if (event.type === 'fire') enqueue(event.segment);
          if (event.type === 'offRoute') setOffRoute(true);
          if (event.type === 'backOnRoute') setOffRoute(false);
        }
        maybeEnqueueOutro();
      });
    } catch (err) {
      // navigator.geolocation is undefined on insecure origins in some
      // browsers, so this can throw synchronously. The intro (if any) was
      // already enqueued above and may already be playing. Without this
      // cleanup, that enqueue's drain loop is left permanently stuck â€”
      // draining.current never returns to false because nothing ever
      // settles its pending audio.play() â€” so a retried start()'s fresh
      // enqueue(intro) would sit in the queue forever, deadlocked, and take
      // every subsequent GPS-triggered segment down with it for the rest of
      // the session. Reset to a clean slate first, mirroring the full reset
      // playSegment already does when it needs one (including bumping
      // `generation`, so the stale loop's tail can't touch shared state
      // after this point even if some future change makes audio.stop() stop
      // resolving it synchronously).
      generation.current += 1;
      audio.stop();
      queue.current = [];
      draining.current = false;
      // Without this rollback, `started` would already be true and
      // `hasStarted` permanently set, leaving the app on the map screen with
      // no live GPS listener and no way back short of remounting. Roll back
      // both so the entry screen re-renders and start() is callable again.
      hasStarted.current = false;
      setStarted(false);
      throw err;
    }
  }, [audio, enqueue, engine, location, maybeEnqueueOutro, tour]);

  const playSegment = useCallback(
    (id: string) => {
      const segment = engine.selectManually(id);
      // A deliberate tap outranks whatever is playing. Automatic triggers
      // still queue (spec Â§8) â€” this interruption is user-initiated.
      generation.current += 1;
      audio.stop();
      // ...and it also outranks a standing pause. stop() has already settled
      // the frozen segment, so resume() here only clears the latch â€” without
      // this, the tapped segment would load silently and the button would
      // look broken.
      audio.resume();
      setPaused(false);
      queue.current = [];
      draining.current = false;
      enqueue(segment);
      maybeEnqueueOutro();
    },
    [audio, enqueue, engine, maybeEnqueueOutro],
  );

  const pause = useCallback(() => {
    audio.pause();
    setPaused(true);
  }, [audio]);

  const resume = useCallback(() => {
    audio.resume();
    setPaused(false);
  }, [audio]);

  // Runs once per mount; its cleanup fires only at unmount, via the refs
  // above. Depending on [audio, location] here would make React tear down
  // the current provider on every identity change and never restart it â€” a
  // consumer that passes fresh audio/location instances on every render
  // (unmemoized) would silently kill the tour mid-walk with no recovery
  // short of calling start() again. Unmount is the only point this hook
  // itself should stop anything.
  useEffect(() => {
    return () => {
      locationRef.current.stop();
      audioRef.current.stop();
    };
  }, []);

  return {
    started,
    start,
    currentSegment,
    playedIds,
    lastFix,
    offRoute,
    playSegment,
    paused,
    pause,
    resume,
  };
}
