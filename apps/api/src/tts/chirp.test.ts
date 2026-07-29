// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ChirpTtsProvider, chirpVoiceName, CHIRP_VOICES } from './chirp.ts';

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('chirpVoiceName', () => {
  it('builds the documented voice identifier', () => {
    expect(chirpVoiceName('sk-SK', 'Aoede')).toBe('sk-SK-Chirp3-HD-Aoede');
    expect(chirpVoiceName('de-DE', 'Puck')).toBe('de-DE-Chirp3-HD-Puck');
  });

  it('offers all eight voices, which are shared across every language', () => {
    // The sharing is the point: a persona keeps its identity across the
    // catalogue, so the same narrator sounds like one person in Slovak and
    // in German.
    expect(CHIRP_VOICES).toHaveLength(8);
  });
});

describe('ChirpTtsProvider', () => {
  const audio = Buffer.from('fake-mp3-bytes').toString('base64');

  it('decodes the base64 audio the API returns', async () => {
    const provider = new ChirpTtsProvider({
      apiKey: 'test-key',
      fetch: fakeFetch({ audioContent: audio }),
    });

    const result = await provider.synthesize({
      text: 'Hviezdoslavovo námestie',
      languageCode: 'sk-SK',
      voice: 'sk-SK-Chirp3-HD-Aoede',
    });

    expect(Buffer.from(result.audio).toString()).toBe('fake-mp3-bytes');
    expect(result.contentType).toBe('audio/mpeg');
  });

  it('bills by characters, not tokens', async () => {
    const provider = new ChirpTtsProvider({
      apiKey: 'test-key',
      fetch: fakeFetch({ audioContent: audio }),
    });
    const text = 'Michalská brána';
    const result = await provider.synthesize({
      text,
      languageCode: 'sk-SK',
      voice: 'sk-SK-Chirp3-HD-Aoede',
    });
    expect(result.characters).toBe(text.length);
  });

  it('requests MP3 for the given voice and language', async () => {
    const doFetch = fakeFetch({ audioContent: audio });
    const provider = new ChirpTtsProvider({ apiKey: 'test-key', fetch: doFetch });

    await provider.synthesize({
      text: 'x',
      languageCode: 'de-DE',
      voice: 'de-DE-Chirp3-HD-Puck',
    });

    const [, init] = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.voice).toEqual({ languageCode: 'de-DE', name: 'de-DE-Chirp3-HD-Puck' });
    expect(sent.audioConfig.audioEncoding).toBe('MP3');
  });

  it('never puts the API key in an error message', async () => {
    // The key is a query parameter, so a naive error that echoes the URL
    // leaks it into logs and into the job row shown in the browser — the
    // same defect the Mapbox token already caused once in this project.
    const provider = new ChirpTtsProvider({
      apiKey: 'super-secret-key',
      fetch: fakeFetch({ error: { message: 'quota exceeded' } }, 429),
    });

    const err = await provider
      .synthesize({ text: 'x', languageCode: 'sk-SK', voice: 'sk-SK-Chirp3-HD-Aoede' })
      .then(() => null, (e: Error) => e);

    expect(err).toBeTruthy();
    expect(err?.message).not.toContain('super-secret-key');
    expect(err?.message).toContain('429');
  });

  it('fails loudly when the response carries no audio', async () => {
    const provider = new ChirpTtsProvider({
      apiKey: 'test-key',
      fetch: fakeFetch({}),
    });

    await expect(
      provider.synthesize({ text: 'x', languageCode: 'sk-SK', voice: 'sk-SK-Chirp3-HD-Aoede' }),
    ).rejects.toThrow(/no audioContent/i);
  });
});
