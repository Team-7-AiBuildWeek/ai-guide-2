import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GenerateRequest, Tour } from '@ai-guide/shared';
import { amsterdamTour } from './fixtures/amsterdam-tour';
import { useTourPlayer } from './hooks/useTourPlayer';
import { useWakeLock } from './hooks/useWakeLock';
import { SimulatedLocation } from './lib/location/simulated';
import { BrowserLocation } from './lib/location/browser';
import { SpeechSynthesisPlayer } from './lib/audio/speechSynthesis';
import { HtmlAudioPlayer } from './lib/audio/htmlAudio';
import {
  createApiClient,
  WrongPassphraseError,
  getStoredPassphrase,
  setStoredPassphrase,
  clearStoredPassphrase,
} from './lib/api/client';
import { loadLatest, saveTour } from './lib/storage/tourStore';
import { TourMap } from './components/TourMap';
import { NowPlaying } from './components/NowPlaying';
import { StopList } from './components/StopList';
import { DevPanel } from './components/DevPanel';
import { GenerateScreen } from './components/GenerateScreen';
import { ProgressScreen } from './components/ProgressScreen';

// ?sim=1 in the URL runs the simulator instead of real GPS. Read once at
// module scope — never recomputed per render — so it cannot make the
// `location` memo below see a changing dependency and rebuild the provider.
const simRequested = new URLSearchParams(window.location.search).has('sim');

// ?demo=1 skips generation entirely and loads the built-in Amsterdam
// fixture — the dev-only affordance that keeps the manual walkthroughs in
// docs/TESTING.md working now that the app's default path is
// generate → progress → player rather than the fixture alone.
//
// Deliberately INDEPENDENT of ?sim=1. Having sim imply demo meant the
// simulator could only ever walk Amsterdam, so the one thing you most want
// to test — a freshly generated tour, without going outside — was the one
// thing you could not. Combine them (?sim=1&demo=1) for the original
// Amsterdam walkthrough.
const demoRequested = new URLSearchParams(window.location.search).has('demo');

/**
 * The existing GPS-triggered player, unchanged from Plan 1 — it consumes a
 * `Tour` and does not care where that `Tour` came from. Pulled into its own
 * component (rather than left inline in `App`) purely so its hooks
 * (`useTourPlayer`, `useWakeLock`, ...) are never called while `tour` might
 * still be null; App itself decides *whether* to render this, not this
 * component.
 */
function Player({ tour }: { tour: Tour }) {
  const [gpsError, setGpsError] = useState<string | null>(null);

  const location = useMemo(
    () =>
      simRequested
        ? new SimulatedLocation(tour.routeGeoJson, {
            intervalMs: 1000,
            accuracyM: 12,
            noiseM: 8,
          })
        : new BrowserLocation(setGpsError),
    [tour, setGpsError],
  );
  /**
   * Real recorded narration when the tour has it, the browser's own voice
   * otherwise.
   *
   * Chosen per tour rather than globally: a tour generated before the voice
   * pipeline existed, or one whose synthesis failed, still plays — with a
   * robotic voice, but it plays. Silence would be the worse failure, and this
   * is an audio-first app where "no sound" is indistinguishable from "broken".
   *
   * Note both branches depend on `tour`, so switching tours rebuilds the
   * player. Constructing either inline in the component body instead would
   * make a new object every render and silently kill a running tour — a trap
   * this codebase has documented since Plan 1.
   */
  const audio = useMemo(
    () =>
      tour.segments.some((s) => s.audioUrl !== null)
        ? new HtmlAudioPlayer()
        : new SpeechSynthesisPlayer(tour.language),
    [tour],
  );

  const player = useTourPlayer({ tour, location, audio });
  useWakeLock(player.started);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

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
            setStartError(null);
            try {
              await player.start();
            } catch {
              setStartError('Could not start the walk. Please try again.');
            } finally {
              setStarting(false);
            }
          }}
          className="rounded-full bg-blue-600 px-8 py-4 text-lg font-semibold disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start the walk'}
        </button>
        {startError !== null && (
          <p className="text-sm font-medium text-red-400" role="alert">
            {startError}
          </p>
        )}
        <p className="max-w-xs text-xs text-slate-400">
          Keep your phone in your hand with the screen on. Narration starts by itself as
          you arrive at each stop.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      {gpsError !== null && (
        <p
          className="shrink-0 bg-red-600 px-4 py-2 text-center text-sm font-medium text-white"
          role="alert"
        >
          {gpsError}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <TourMap
          tour={tour}
          lastFix={player.lastFix}
          playedIds={player.playedIds}
          onSelectStop={player.playSegment}
        />
        {simRequested && <DevPanel sim={location as SimulatedLocation} tour={tour} />}
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

export default function App() {
  const [tour, setTour] = useState<Tour | null>(demoRequested ? amsterdamTour : null);
  const [loadingStore, setLoadingStore] = useState(!demoRequested);
  const [jobId, setJobId] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  /** Show the passphrase field: none stored yet, or the stored one was wrong. */
  const [needsPassphrase, setNeedsPassphrase] = useState(() => getStoredPassphrase() === null);

  const apiClient = useMemo(() => createApiClient(), []);

  // Whatever tour was generated (or resumed) last time, on a device that
  // never talks to anything until a fresh generate is requested.
  useEffect(() => {
    if (demoRequested) return;
    let cancelled = false;
    loadLatest()
      .then((stored) => {
        if (!cancelled) setTour(stored);
      })
      .finally(() => {
        if (!cancelled) setLoadingStore(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGenerate = useCallback(
    async (request: GenerateRequest, passphrase?: string) => {
      setGenerateError(null);

      // The passphrase now comes from a field in the form rather than a
      // `window.prompt`. iOS Safari can suppress prompts in standalone PWA
      // mode — the mode you are in after adding this to a home screen for a
      // walk — and a dismissed prompt aborted silently with no feedback.
      if (passphrase !== undefined && passphrase.length > 0) {
        setStoredPassphrase(passphrase);
      }
      if (getStoredPassphrase() === null) {
        setNeedsPassphrase(true);
        return;
      }

      try {
        const { jobId: newJobId } = await apiClient.createTour(request);
        setJobId(newJobId);
      } catch (err) {
        if (err instanceof WrongPassphraseError) {
          // Clear it so the next attempt asks again instead of silently
          // retrying the same wrong value forever.
          clearStoredPassphrase();
          setNeedsPassphrase(true);
          setGenerateError('Wrong passphrase. Please try again.');
        } else {
          setGenerateError('Could not start generation. Please try again.');
        }
      }
    },
    [apiClient],
  );

  const handleComplete = useCallback(
    async (tourId: string) => {
      const finished = await apiClient.getTour(tourId);
      await saveTour(finished);
      setJobId(null);
      setTour(finished);
    },
    [apiClient],
  );

  const handleRetry = useCallback(() => setJobId(null), []);

  if (tour) return <Player tour={tour} />;
  if (loadingStore) return null;
  if (jobId) {
    return (
      <ProgressScreen
        jobId={jobId}
        subscribeToJob={apiClient.subscribeToJob}
        onComplete={handleComplete}
        onRetry={handleRetry}
      />
    );
  }
  return (
    <GenerateScreen
      onGenerate={handleGenerate}
      error={generateError}
      needsPassphrase={needsPassphrase}
    />
  );
}
