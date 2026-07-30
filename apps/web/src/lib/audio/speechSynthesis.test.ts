import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpeechSynthesisPlayer } from './speechSynthesis';
import type { Segment } from '@ai-guide/shared';

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = '';
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function installFakeSpeech() {
  const spoken: FakeUtterance[] = [];
  const synth = {
    speak: vi.fn((u: FakeUtterance) => {
      spoken.push(u);
      // Don't auto-complete; tests control when onend fires via endSpeaking()
    }),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    speaking: false,
  };
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

  // Helper to manually fire onend on the most recently spoken utterance
  const endSpeaking = () => {
    if (spoken.length > 0) {
      const last = spoken[spoken.length - 1];
      queueMicrotask(() => last.onend?.());
    }
  };

  return { synth, spoken, endSpeaking };
}

const segment: Segment = {
  id: 'seg-0',
  kind: 'stop',
  order: 0,
  title: 'Dam Square',
  script: 'You are standing on Dam Square.',
  audioUrl: null,
  durationMs: null,
  trigger: { lat: 52.3731, lng: 4.8936 },
  triggerRadiusM: 25,
  poiIds: ['poi-0'],
};

describe('SpeechSynthesisPlayer', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('speaks the segment script', async () => {
    const { spoken, endSpeaking } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    const playPromise = player.play(segment);
    endSpeaking();
    await playPromise;
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('You are standing on Dam Square.');
  });

  it('sets the utterance language', async () => {
    const { spoken, endSpeaking } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('nl');
    const playPromise = player.play(segment);
    endSpeaking();
    await playPromise;
    expect(spoken[0].lang).toBe('nl');
  });

  it('reports isPlaying while speaking', async () => {
    const { endSpeaking } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    expect(player.isPlaying()).toBe(false);
    const pending = player.play(segment);
    expect(player.isPlaying()).toBe(true);
    endSpeaking();
    await pending;
    expect(player.isPlaying()).toBe(false);
  });

  it('settles the play() promise when stop() is called', async () => {
    const { synth } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    const playPromise = player.play(segment);
    player.stop();
    expect(synth.cancel).toHaveBeenCalled();
    // The key test: the promise must settle, not hang
    await expect(playPromise).resolves.toBeUndefined();
    expect(player.isPlaying()).toBe(false);
  });

  it('cancels the previous segment when a new one starts', async () => {
    const { synth, endSpeaking } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    void player.play(segment);
    const nextPromise = player.play({ ...segment, id: 'seg-1', script: 'Next stop.' });
    endSpeaking();
    await nextPromise;
    expect(synth.cancel).toHaveBeenCalled();
  });

  it('protects against stale callbacks when a second play overwrites the first', async () => {
    const { spoken } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    // Start first segment
    const firstPromise = player.play(segment);
    expect(spoken).toHaveLength(1);
    // Start second segment (which calls stop() and cancel())
    const secondPromise = player.play({
      ...segment,
      id: 'seg-1',
      script: 'Next stop.',
    });
    expect(spoken).toHaveLength(2);
    // First should be settled immediately
    await expect(firstPromise).resolves.toBeUndefined();
    // Fire the first segment's callback late (simulating cancel() failure)
    spoken[0].onend?.();
    // The second segment must still be settleable via stop()
    player.stop();
    await expect(secondPromise).resolves.toBeUndefined();
    expect(player.isPlaying()).toBe(false);
  });

  describe('pause and resume', () => {
    it('drives the global speechSynthesis pause state', () => {
      const { synth } = installFakeSpeech();
      const player = new SpeechSynthesisPlayer('en');
      player.pause();
      expect(player.isPaused()).toBe(true);
      expect(synth.pause).toHaveBeenCalled();
      player.resume();
      expect(player.isPaused()).toBe(false);
      expect(synth.resume).toHaveBeenCalled();
    });

    it('pausing does not settle the in-flight play()', async () => {
      const { synth } = installFakeSpeech();
      const player = new SpeechSynthesisPlayer('en');
      const playPromise = player.play(segment);
      player.pause();

      let settled = false;
      void playPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(synth.cancel).toHaveBeenCalledTimes(1); // only play()'s own leading stop()
    });

    it('a segment spoken while paused re-asserts the pause', () => {
      // stop() at the head of play() calls cancel(), and some browsers drop
      // the global paused flag on cancel — so play() must pause again.
      const { synth } = installFakeSpeech();
      const player = new SpeechSynthesisPlayer('en');
      player.pause();
      expect(synth.pause).toHaveBeenCalledTimes(1);
      void player.play(segment);
      expect(synth.pause).toHaveBeenCalledTimes(2);
    });

    it('the pause survives stop()', () => {
      installFakeSpeech();
      const player = new SpeechSynthesisPlayer('en');
      player.pause();
      player.stop();
      expect(player.isPaused()).toBe(true);
    });
  });
});
