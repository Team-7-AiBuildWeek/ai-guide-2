import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HtmlAudioPlayer } from './htmlAudio';
import type { Segment } from '../../types/tour';

class FakeAudio {
  src = '';
  preload = '';
  paused = true;
  listeners: Record<string, Set<() => void>> = {
    ended: new Set(),
    error: new Set(),
  };

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  addEventListener(event: string, handler: () => void): void {
    if (event in this.listeners) {
      this.listeners[event].add(handler);
    }
  }

  removeEventListener(event: string, handler: () => void): void {
    if (event in this.listeners) {
      this.listeners[event].delete(handler);
    }
  }

  fireEnded(): void {
    this.listeners.ended.forEach((handler) => handler());
  }

  fireError(): void {
    this.listeners.error.forEach((handler) => handler());
  }
}

function installFakeAudio() {
  let fakeAudio: FakeAudio;
  vi.stubGlobal('Audio', class extends FakeAudio {
    constructor() {
      super();
      fakeAudio = this;
    }
  });
  return { getFakeAudio: () => fakeAudio };
}

const segment: Segment = {
  id: 'seg-0',
  kind: 'stop',
  order: 0,
  title: 'Dam Square',
  script: 'You are standing on Dam Square.',
  audioUrl: 'https://example.com/audio.mp3',
  durationMs: 5000,
  trigger: { lat: 52.3731, lng: 4.8936 },
  triggerRadiusM: 25,
  poiId: 'poi-0',
};

describe('HtmlAudioPlayer', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('resolves play() when the fake fires ended', async () => {
    const { getFakeAudio } = installFakeAudio();
    const player = new HtmlAudioPlayer();
    const playPromise = player.play(segment);
    const fakeAudio = getFakeAudio();
    fakeAudio.fireEnded();
    await expect(playPromise).resolves.toBeUndefined();
  });

  it('settles play() promise when stop() is called mid-playback', async () => {
    installFakeAudio();
    const player = new HtmlAudioPlayer();
    const playPromise = player.play(segment);
    player.stop();
    await expect(playPromise).resolves.toBeUndefined();
  });

  it('starting a second play() while one is in flight settles the first', async () => {
    const { getFakeAudio } = installFakeAudio();
    const player = new HtmlAudioPlayer();
    const firstPromise = player.play(segment);
    const fakeAudio = getFakeAudio();
    const listenerCountBefore = fakeAudio.listeners.ended.size;
    const secondPromise = player.play({
      ...segment,
      id: 'seg-1',
      audioUrl: 'https://example.com/audio2.mp3',
    });
    const listenerCountAfter = fakeAudio.listeners.ended.size;
    // First should be settled immediately when second starts
    await expect(firstPromise).resolves.toBeUndefined();
    // Only one pair of listeners should be active
    expect(listenerCountAfter).toBe(listenerCountBefore);
    // Second should also resolve (even without firing ended)
    player.stop();
    await expect(secondPromise).resolves.toBeUndefined();
  });

  it('play() with audioUrl: null resolves rather than rejecting', async () => {
    installFakeAudio();
    const player = new HtmlAudioPlayer();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const playPromise = player.play({
      ...segment,
      audioUrl: null,
    });
    await expect(playPromise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('isPlaying() transitions correctly and is not corrupted by stale callbacks', async () => {
    const { getFakeAudio } = installFakeAudio();
    const player = new HtmlAudioPlayer();
    expect(player.isPlaying()).toBe(false);
    const playPromise = player.play(segment);
    expect(player.isPlaying()).toBe(true);
    const fakeAudio = getFakeAudio();
    fakeAudio.fireEnded();
    await playPromise;
    expect(player.isPlaying()).toBe(false);
  });
});
