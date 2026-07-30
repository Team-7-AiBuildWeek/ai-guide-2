interface WalkControlsProps {
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  listOpen: boolean;
  onToggleList: () => void;
}

/**
 * The floating bottom controls of the walk screen — the row that makes it
 * read as navigation rather than a document: one big round pause/resume
 * button for the guide's voice, and a pill that raises the stop list.
 *
 * Pause is always tappable, even in the silence between segments: it is a
 * latch on the guide ("be quiet until I say otherwise"), not a property of
 * one clip, so pausing early must hold the next trigger too — see
 * AudioPlayer.pause().
 */
export function WalkControls({
  paused,
  onPause,
  onResume,
  listOpen,
  onToggleList,
}: WalkControlsProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <button
        onClick={onToggleList}
        className="pointer-events-auto rounded-full bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-lg active:bg-slate-100"
        aria-expanded={listOpen}
      >
        {listOpen ? 'Hide stops' : 'Stops'}
      </button>

      <button
        onClick={paused ? onResume : onPause}
        aria-label={paused ? 'Resume the guide' : 'Pause the guide'}
        className={`pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full shadow-xl transition-colors ${
          paused ? 'bg-blue-600 text-white' : 'bg-white text-slate-800 active:bg-slate-100'
        }`}
      >
        {paused ? (
          // Play triangle, nudged right so it reads centred.
          <svg viewBox="0 0 24 24" className="ml-1 h-8 w-8" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="currentColor" aria-hidden="true">
            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
          </svg>
        )}
      </button>

      {/* Spacer mirroring the stops pill, so the pause button sits centred. */}
      <div className="w-[88px]" aria-hidden="true" />
    </div>
  );
}
