import type { Segment } from '@ai-guide/shared';

export interface AudioPlayer {
  /**
   * Must be called from inside a user gesture handler. iOS Safari will not
   * allow programmatic playback until audio has been started once by a tap.
   */
  unlock(): Promise<void>;
  /**
   * Plays a segment. Always resolves, never rejects. If the segment has no
   * audioUrl or playback fails, logs a warning and resolves immediately.
   * Resolves when the segment finishes playing or is stopped.
   */
  play(segment: Segment): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
  /**
   * Freezes playback in place; `resume()` continues from the same point.
   *
   * Distinct from `stop()` on purpose: stop() SETTLES the current play()
   * promise (the drain loop moves on to the next segment), while pause()
   * leaves it pending — the tour holds its breath rather than skipping
   * ahead. Pausing while nothing is playing is a no-op, not an error, and
   * the pause survives across segments: anything triggered while paused
   * queues up behind the frozen one.
   */
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}
