import type { AudioPlayer } from './types';
import type { Segment } from '../../types/tour';

/**
 * Plays pre-generated MP3s through a single persistent <audio> element.
 *
 * The single-element design is deliberate: iOS Safari only permits
 * programmatic playback on an element that has already been played from a user
 * gesture. Creating a fresh element per segment would be blocked from the
 * second segment onward.
 */
export class HtmlAudioPlayer implements AudioPlayer {
  private readonly element: HTMLAudioElement;
  private playing = false;
  private currentResolve: (() => void) | null = null;
  private currentCleanup: (() => void) | null = null;

  constructor() {
    this.element = new Audio();
    this.element.preload = 'auto';
  }

  async unlock(): Promise<void> {
    // A 1-sample silent WAV. Playing it inside a gesture marks the element as
    // user-activated for the rest of the session.
    this.element.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    try {
      await this.element.play();
    } catch {
      // Some browsers reject even the silent play; playback often still works.
    }
    this.element.pause();
  }

  play(segment: Segment): Promise<void> {
    if (segment.audioUrl === null) {
      console.warn(`Segment ${segment.id} has no audioUrl`);
      return Promise.resolve();
    }

    // Settle any previous playback first
    this.stop();

    return new Promise<void>((resolve) => {
      const finish = () => {
        cleanup();
        this.playing = false;
        resolve();
      };
      const fail = () => {
        cleanup();
        this.playing = false;
        console.warn(`Playback failed for segment ${segment.id}`);
        resolve();
      };
      const cleanup = () => {
        this.element.removeEventListener('ended', finish);
        this.element.removeEventListener('error', fail);
        this.currentResolve = null;
        this.currentCleanup = null;
      };

      this.currentResolve = resolve;
      this.currentCleanup = cleanup;

      this.element.addEventListener('ended', finish);
      this.element.addEventListener('error', fail);

      this.element.src = segment.audioUrl as string;
      this.playing = true;
      void this.element.play().catch(fail);
    });
  }

  stop(): void {
    // Store references before calling cleanup (which clears them)
    const resolve = this.currentResolve;
    const cleanup = this.currentCleanup;

    if (cleanup) {
      cleanup();
    }
    if (resolve) {
      resolve();
    }
    this.element.pause();
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
