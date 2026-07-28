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
}
