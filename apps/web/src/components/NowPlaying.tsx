import type { Segment } from '@ai-guide/shared';

interface NowPlayingProps {
  segment: Segment | null;
  offRoute: boolean;
  paused: boolean;
}

/**
 * The floating instruction banner at the top of the walk screen — the
 * navigation-app slot that would show "Turn left onto Michalská". Here it
 * carries the guide's state: what is being narrated, that the guide is
 * paused, or that the walker has left the route.
 */
export function NowPlaying({ segment, offRoute, paused }: NowPlayingProps) {
  if (offRoute) {
    return (
      <div className="rounded-2xl bg-amber-500 px-4 py-3 text-sm font-medium text-white shadow-lg">
        You have wandered off the route. Head back to the blue line to carry on.
      </div>
    );
  }

  if (segment === null) {
    return (
      <div className="rounded-2xl bg-slate-900/90 px-4 py-3 text-sm text-slate-300 shadow-lg backdrop-blur">
        {paused
          ? 'Guide paused — narration will wait until you resume.'
          : 'Walking — narration will start when you reach the next stop.'}
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-slate-900/90 px-4 py-3 text-white shadow-lg backdrop-blur">
      <p className="text-xs uppercase tracking-wide text-slate-400">
        {paused ? 'Paused' : 'Now playing'}
      </p>
      {/* This is an audio-first app; a screen-reader user gets no other cue
          that narration has moved to a new segment. */}
      <p className="text-base font-semibold" aria-live="polite">
        {segment.title}
      </p>
    </div>
  );
}
