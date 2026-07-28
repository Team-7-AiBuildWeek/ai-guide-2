import type { Segment } from '../../types/tour';

export interface AudioPlayer {
  /**
   * Must be called from inside a user gesture handler. iOS Safari will not
   * allow programmatic playback until audio has been started once by a tap.
   */
  unlock(): Promise<void>;
  /** Resolves when the segment has finished playing or was stopped. */
  play(segment: Segment): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
}
