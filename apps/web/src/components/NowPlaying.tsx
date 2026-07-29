import type { Segment } from '@ai-guide/shared';

interface NowPlayingProps {
  segment: Segment | null;
  offRoute: boolean;
}

export function NowPlaying({ segment, offRoute }: NowPlayingProps) {
  if (offRoute) {
    return (
      <div className="bg-amber-500 px-4 py-3 text-sm font-medium text-white">
        You have wandered off the route. Head back to the blue line to carry on.
      </div>
    );
  }

  if (segment === null) {
    return (
      <div className="bg-slate-800 px-4 py-3 text-sm text-slate-300">
        Walking â€” narration will start when you reach the next stop.
      </div>
    );
  }

  return (
    <div className="bg-slate-900 px-4 py-3 text-white">
      <p className="text-xs uppercase tracking-wide text-slate-400">Now playing</p>
      {/* This is an audio-first app; a screen-reader user gets no other cue
          that narration has moved to a new segment. */}
      <p className="text-base font-semibold" aria-live="polite">
        {segment.title}
      </p>
    </div>
  );
}
