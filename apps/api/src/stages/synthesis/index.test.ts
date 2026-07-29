// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { NarrationOutput } from '@ai-guide/shared';
import { synthesizeTour, toBcp47 } from './index.ts';
import { InMemoryAudioStore, audioKey } from '../../tts/audioStore.ts';
import type { SynthesisRequest, SynthesisResult, TtsProvider } from '../../tts/types.ts';

class CountingTts implements TtsProvider {
  readonly name = 'counting';
  calls: SynthesisRequest[] = [];

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    this.calls.push(request);
    return {
      audio: new TextEncoder().encode(`audio:${request.text}`),
      contentType: 'audio/mpeg',
      characters: request.text.length,
    };
  }
}

function segments(scripts: string[]): NarrationOutput['segments'] {
  return scripts.map((script, i) => ({
    order: i,
    kind: i === 0 ? 'intro' : 'stop',
    title: `Segment ${i}`,
    script,
  })) as NarrationOutput['segments'];
}

describe('toBcp47', () => {
  it('maps every supported language', () => {
    expect(toBcp47('sk')).toBe('sk-SK');
    expect(toBcp47('de')).toBe('de-DE');
  });

  it('throws rather than guessing an unmapped locale', () => {
    expect(() => toBcp47('ja')).toThrow(/no tts locale/i);
  });
});

describe('synthesizeTour', () => {
  it('gives every segment an audio URL', async () => {
    const tts = new CountingTts();
    const store = new InMemoryAudioStore();

    const result = await synthesizeTour(segments(['one', 'two', 'three']), { language: 'sk', voice: 'Aoede' }, { tts, store });

    expect([...result.audioUrlByOrder.keys()].sort()).toEqual([0, 1, 2]);
    expect(result.charactersBilled).toBe('one'.length + 'two'.length + 'three'.length);
  });

  it('synthesises identical text once within a tour', async () => {
    const tts = new CountingTts();
    const store = new InMemoryAudioStore();

    // Three segments, two identical.
    const result = await synthesizeTour(
      segments(['same words', 'different', 'same words']),
      { language: 'sk', voice: 'Aoede' },
      { tts, store },
    );

    expect(tts.calls).toHaveLength(2);
    expect(result.audioUrlByOrder.get(0)).toBe(result.audioUrlByOrder.get(2));
    expect(result.charactersBilled).toBe('same words'.length + 'different'.length);
  });

  it('reuses audio across tours, which is the point of content addressing', async () => {
    // The facts about a place do not change between travellers. The first
    // tour pays for that segment; every tour after it does not.
    const store = new InMemoryAudioStore();

    const first = new CountingTts();
    await synthesizeTour(segments(['about the cathedral']), { language: 'sk', voice: 'Aoede' }, { tts: first, store });

    const second = new CountingTts();
    const result = await synthesizeTour(
      segments(['about the cathedral']),
      { language: 'sk', voice: 'Aoede' },
      { tts: second, store },
    );

    expect(second.calls).toHaveLength(0);
    expect(result.charactersBilled).toBe(0);
    expect(result.reused).toBe(1);
    expect(result.audioUrlByOrder.get(0)).toBeTruthy();
  });

  it('does not confuse the same text in different languages', async () => {
    const tts = new CountingTts();
    const store = new InMemoryAudioStore();

    await synthesizeTour(segments(['Hlavné námestie']), { language: 'sk', voice: 'Aoede' }, { tts, store });
    await synthesizeTour(segments(['Hlavné námestie']), { language: 'de', voice: 'Aoede' }, { tts, store });

    expect(tts.calls).toHaveLength(2);
    expect(store.size).toBe(2);
  });

  it('does not confuse the same text in different voices', async () => {
    const tts = new CountingTts();
    const store = new InMemoryAudioStore();

    await synthesizeTour(segments(['x']), { language: 'sk', voice: 'Aoede' }, { tts, store });
    await synthesizeTour(segments(['x']), { language: 'sk', voice: 'Puck' }, { tts, store });

    expect(store.size).toBe(2);
  });

  it('requests the mapped locale and the full Chirp voice name', async () => {
    const tts = new CountingTts();
    await synthesizeTour(segments(['x']), { language: 'sk', voice: 'Aoede' }, { tts, store: new InMemoryAudioStore() });

    expect(tts.calls[0].languageCode).toBe('sk-SK');
    expect(tts.calls[0].voice).toBe('sk-SK-Chirp3-HD-Aoede');
  });

  it('keys on what was said, never on the audio bytes', async () => {
    // Chirp is non-deterministic — measured returning 4736, 4736 and then
    // 3712 bytes for identical input. Hashing output would defeat the cache
    // and silently re-bill every render.
    const store = new InMemoryAudioStore();
    const wobbly: TtsProvider = {
      name: 'wobbly',
      synthesize: vi.fn(async (r: SynthesisRequest) => ({
        audio: new TextEncoder().encode(`${Math.random()}`),
        contentType: 'audio/mpeg',
        characters: r.text.length,
      })),
    };

    await synthesizeTour(segments(['stable text']), { language: 'sk', voice: 'Aoede' }, { tts: wobbly, store });
    await synthesizeTour(segments(['stable text']), { language: 'sk', voice: 'Aoede' }, { tts: wobbly, store });

    expect(wobbly.synthesize).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it('addresses audio by a hash of text, language and voice together', () => {
    const a = audioKey({ text: 't', languageCode: 'sk-SK', voice: 'v' });
    expect(a).toBe(audioKey({ text: 't', languageCode: 'sk-SK', voice: 'v' }));
    expect(a).not.toBe(audioKey({ text: 't', languageCode: 'de-DE', voice: 'v' }));
    expect(a).not.toBe(audioKey({ text: 't', languageCode: 'sk-SK', voice: 'w' }));
  });
});
