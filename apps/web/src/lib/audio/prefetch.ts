import type { Tour } from '@ai-guide/shared';

export interface PrefetchProgress {
  done: number;
  total: number;
}

/**
 * Downloads every segment's audio so the walk works without signal.
 *
 * The service worker caches on request, which without this would mean each
 * MP3 is fetched at the moment the walker arrives at its stop — precisely
 * when they are most likely to be in a narrow street with no data. Pulling
 * the whole tour down while they are still deciding to set off inverts that:
 * the risky moment happens indoors, on wifi, before it matters.
 *
 * Failures are swallowed per segment rather than aborting. A tour that
 * cached nineteen of twenty-one stops is a good tour with two gaps; one that
 * gave up at the first timeout is a bad one.
 */
export async function prefetchTourAudio(
  tour: Tour,
  options: {
    onProgress?: (progress: PrefetchProgress) => void;
    concurrency?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PrefetchProgress> {
  const doFetch = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? 3;

  // Distinct URLs, not segments: identical narration shares one file, and
  // fetching it twice would just be slower.
  const urls = [...new Set(tour.segments.map((s) => s.audioUrl).filter((u): u is string => u !== null))];

  const total = urls.length;
  let done = 0;
  options.onProgress?.({ done, total });

  for (let i = 0; i < urls.length; i += concurrency) {
    await Promise.all(
      urls.slice(i, i + concurrency).map(async (url) => {
        try {
          // The response body must be consumed for the service worker to
          // store it; a bare fetch() leaves the stream unread.
          const res = await doFetch(url);
          if (res.ok) await res.blob();
        } catch {
          // Deliberately silent per segment — see above.
        } finally {
          done += 1;
          options.onProgress?.({ done, total });
        }
      }),
    );
  }

  return { done, total };
}
