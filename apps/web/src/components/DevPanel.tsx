import { useState } from 'react';
import type { SimulatedLocation } from '../lib/location/simulated';
import type { LatLng, Segment, Tour } from '@ai-guide/shared';
import { fractionAlongLineString } from '@ai-guide/shared';

interface DevPanelProps {
  sim: SimulatedLocation;
  tour: Tour;
}

/** Narrows to segments with a real trigger coordinate, for the type checker. */
function hasTrigger(s: Segment): s is Segment & { trigger: LatLng } {
  return s.trigger !== null;
}

/**
 * Runtime controls for the location simulator. Only rendered when the app is
 * started with ?sim=1. This is what makes the trigger engine iterable in
 * seconds rather than afternoons of walking around a city.
 */
export function DevPanel({ sim, tour }: DevPanelProps) {
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);

  const stops = tour.segments.filter(hasTrigger);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute right-3 top-3 z-10 rounded bg-black/70 px-3 py-1.5 text-xs font-mono text-white"
      >
        dev
      </button>
    );
  }

  return (
    <div className="absolute right-3 top-3 z-10 w-60 space-y-3 rounded-lg bg-black/85 p-3 font-mono text-xs text-white">
      <div className="flex items-center justify-between">
        <span className="font-bold">Simulator</span>
        <button onClick={() => setOpen(false)} className="text-slate-400">
          close
        </button>
      </div>

      <label className="block">
        Speed: {speed}Ã—
        <input
          type="range"
          min={1}
          max={20}
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpeed(v);
            sim.setSpeed(v);
          }}
          className="w-full"
        />
      </label>

      <button
        onClick={() => {
          if (paused) sim.resume();
          else sim.pause();
          setPaused(!paused);
        }}
        className="w-full rounded bg-slate-700 py-1.5"
      >
        {paused ? 'resume' : 'pause'}
      </button>

      <button
        onClick={() =>
          sim.injectFix({ lat: 0, lng: 0, accuracyM: 300, timestamp: Date.now() })
        }
        className="w-full rounded bg-amber-700 py-1.5"
        title="Should be discarded by the engine's accuracy gate"
      >
        inject bad fix
      </button>

      <div className="space-y-1">
        <span className="text-slate-400">jump to</span>
        {stops.map((stop) => (
          <button
            key={stop.id}
            onClick={() =>
              sim.jumpTo(fractionAlongLineString(stop.trigger, tour.routeGeoJson))
            }
            className="block w-full truncate rounded bg-slate-700 px-2 py-1 text-left"
          >
            {stop.title}
          </button>
        ))}
      </div>
    </div>
  );
}
