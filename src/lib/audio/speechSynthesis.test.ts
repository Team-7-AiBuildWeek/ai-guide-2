import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpeechSynthesisPlayer } from './speechSynthesis';
import type { Segment } from '../../types/tour';

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = '';
  constructor(public text: string) {}
}

function installFakeSpeech() {
  const spoken: FakeUtterance[] = [];
  const synth = {
    speak: vi.fn((u: FakeUtterance) => {
      spoken.push(u);
      // Finish on the next microtask so play() can be awaited.
      queueMicrotask(() => u.onend?.());
    }),
    cancel: vi.fn(),
    speaking: false,
  };
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  return { synth, spoken };
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
  poiId: 'poi-0',
};

describe('SpeechSynthesisPlayer', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('speaks the segment script', async () => {
    const { spoken } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    await player.play(segment);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('You are standing on Dam Square.');
  });

  it('sets the utterance language', async () => {
    const { spoken } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('nl');
    await player.play(segment);
    expect(spoken[0].lang).toBe('nl');
  });

  it('reports isPlaying while speaking', async () => {
    installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    expect(player.isPlaying()).toBe(false);
    const pending = player.play(segment);
    expect(player.isPlaying()).toBe(true);
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
    const { synth } = installFakeSpeech();
    const player = new SpeechSynthesisPlayer('en');
    void player.play(segment);
    await player.play({ ...segment, id: 'seg-1', script: 'Next stop.' });
    expect(synth.cancel).toHaveBeenCalled();
  });
});
