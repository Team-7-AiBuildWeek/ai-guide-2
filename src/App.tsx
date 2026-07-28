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
