import { describe, it, expect, vi } from 'vitest';
import type { Tour } from '@ai-guide/shared';
import { prefetchTourAudio } from './prefetch';
import { makeTour, makeSegment } from '../trigger/testFixtures';

function tourWithAudio(urls: (string | null)[]): Tour {
  return makeTour({
    segments: urls.map((audioUrl, i) => makeSegment(i, { id: `seg-${i}`, audioUrl })),
  });
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response('bytes', { status: 200 })) as unknown as typeof fetch;
}

describe('prefetchTourAudio', () => {
  it('downloads every segment that has audio', async () => {
    const fetchImpl = okFetch();
    const result = await prefetchTourAudio(tourWithAudio(['a.mp3', 'b.mp3', 'c.mp3']), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ done: 3, total: 3 });
  });

  it('skips segments with no audio rather than counting them', async () => {
    const fetchImpl = okFetch();
    const result = await prefetchTourAudio(tourWithAudio(['a.mp3', null, 'b.mp3']), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(2);
  });

  it('fetches a shared URL once, however many segments use it', async () => {
    // Identical narration is one file by content addressing; fetching it
    // twice would only be slower.
    const fetchImpl = okFetch();
    await prefetchTourAudio(tourWithAudio(['same.mp3', 'other.mp3', 'same.mp3']), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('consumes the body, without which the service worker stores nothing', async () => {
    const blob = vi.fn(async () => new Blob());
    const fetchImpl = vi.fn(async () => ({ ok: true, blob })) as unknown as typeof fetch;

    await prefetchTourAudio(tourWithAudio(['a.mp3']), { fetchImpl });

    expect(blob).toHaveBeenCalled();
  });

  it('keeps going when one segment fails', async () => {
    // Nineteen of twenty-one cached is a good tour with two gaps. Giving up
    // at the first timeout is a bad one.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error('network');
      return new Response('bytes');
    }) as unknown as typeof fetch;

    const result = await prefetchTourAudio(tourWithAudio(['a.mp3', 'b.mp3', 'c.mp3']), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ done: 3, total: 3 });
  });

  it('reports progress from zero through to completion', async () => {
    const seen: string[] = [];
    await prefetchTourAudio(tourWithAudio(['a.mp3', 'b.mp3']), {
      fetchImpl: okFetch(),
      concurrency: 1,
      onProgress: (p) => seen.push(`${p.done}/${p.total}`),
    });

    expect(seen[0]).toBe('0/2');
    expect(seen.at(-1)).toBe('2/2');
  });

  it('does nothing, gracefully, for a tour with no audio at all', async () => {
    const fetchImpl = okFetch();
    const result = await prefetchTourAudio(tourWithAudio([null, null]), { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ done: 0, total: 0 });
  });
});
