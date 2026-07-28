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
      return Promise.reject(new Error(`Segment ${segment.id} has no audioUrl`));
    }

    this.stop();

    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        this.playing = false;
        resolve();
      };
      const fail = () => {
        cleanup();
        this.playing = false;
        reject(new Error(`Playback failed for segment ${segment.id}`));
      };
      const cleanup = () => {
        this.element.removeEventListener('ended', finish);
        this.element.removeEventListener('error', fail);
      };

      this.element.addEventListener('ended', finish);
      this.element.addEventListener('error', fail);

      this.element.src = segment.audioUrl as string;
      this.playing = true;
      void this.element.play().catch(fail);
    });
  }

  stop(): void {
    this.element.pause();
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
