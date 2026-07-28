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

  const start = useCallback(async () => {
    if (hasStarted.current) return;
    hasStarted.current = true;

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

  // Runs once per mount; its cleanup fires only at unmount, via the refs
  // above. Depending on [audio, location] here would make React tear down
  // the current provider on every identity change and never restart it — a
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

  return { started, start, currentSegment, playedIds, lastFix, offRoute, playSegment };
}
