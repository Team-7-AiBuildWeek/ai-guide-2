import type { AudioPlayer } from './types';
import type { Segment } from '@ai-guide/shared';

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
  private paused = false;
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
    // Settle any previous playback first (must happen on every path)
    this.stop();

    if (segment.audioUrl === null) {
      console.warn(`Segment ${segment.id} has no audioUrl`);
      return Promise.resolve();
    }

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
      // A segment that arrives while the guide is paused loads but does not
      // speak — its promise stays pending, holding the whole queue, until
      // resume(). Without this check a GPS trigger would override the
      // walker's explicit pause, which is the one button they pressed.
      if (!this.paused) {
        void this.element.play().catch(fail);
      }
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
    // Deliberately does NOT clear `paused`: stop() runs at the head of every
    // play(), so clearing here would silently un-pause the guide the moment
    // the next segment triggered. Only resume() lifts a pause.
  }

  pause(): void {
    this.paused = true;
    this.element.pause();
  }

  resume(): void {
    this.paused = false;
    if (this.currentResolve === null) return; // nothing was frozen mid-play
    void this.element.play().catch(() => {
      // The failure path mirrors a play() error: settle the pending segment
      // so the queue moves on, rather than leaving the tour wedged.
      console.warn('Resume failed; skipping the current segment');
      this.stop();
    });
  }

  isPaused(): boolean {
    return this.paused;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
