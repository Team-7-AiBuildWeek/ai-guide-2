import type { AudioPlayer } from './types';
import type { Segment } from '@ai-guide/shared';

/**
 * Speaks narration with the browser's built-in voice.
 *
 * Robotic, and unusable as a shipping experience â€” but it needs no backend,
 * costs nothing, and lets the whole trigger-to-narration loop be demoed before
 * the generation pipeline exists. Replaced by HtmlAudioPlayer in Plan 2.
 */
export class SpeechSynthesisPlayer implements AudioPlayer {
  private playing = false;
  private currentResolve: (() => void) | null = null;
  private readonly lang: string;

  constructor(lang: string) {
    this.lang = lang;
  }

  async unlock(): Promise<void> {
    // speechSynthesis needs no gesture unlock, but some browsers stay silent
    // until the queue has been touched at least once from a user gesture.
    speechSynthesis.cancel();
  }

  play(segment: Segment): Promise<void> {
    // Settle any previous playback first
    this.stop();

    return new Promise<void>((resolve) => {
      // Capture the resolve for this call so stale callbacks can't mutate shared state
      const callResolve = resolve;

      const finish = () => {
        // Only mutate state if this is still the current call
        if (this.currentResolve === callResolve) {
          this.playing = false;
          this.currentResolve = null;
        }
        resolve();
      };

      const utterance = new SpeechSynthesisUtterance(segment.script);
      utterance.lang = this.lang;

      utterance.onend = finish;
      utterance.onerror = () => {
        finish();
        console.warn(`Speech synthesis error for segment ${segment.id}`);
      };

      this.currentResolve = callResolve;
      this.playing = true;
      speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    speechSynthesis.cancel();
    if (this.currentResolve) {
      this.currentResolve();
      this.currentResolve = null;
    }
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
