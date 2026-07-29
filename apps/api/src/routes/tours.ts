import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { GenerateRequestSchema } from '@ai-guide/shared';
import type { TourRepository } from '../db/repository.ts';
import type { LlmClient } from '../llm/anthropic.ts';
import { findCityConfig } from '../config/cities.ts';
import { runPipeline } from '../orchestrator.ts';
import { scrubSecrets } from '../scrub.ts';
import type { TtsProvider } from '../tts/types.ts';
import type { AudioStore } from '../tts/audioStore.ts';

export interface ToursRouteDeps {
  repo: TourRepository;
  llm: LlmClient;
  fetch: typeof fetch;
  /** Redacting fetch for Mapbox Directions — see `OrchestratorDeps`. */
  mapboxFetch?: typeof fetch;
  mapboxToken: string;
  /** Voice — see `OrchestratorDeps`. Optional; without them tours have no audio. */
  tts?: TtsProvider;
  audioStore?: AudioStore;
  /** Middleware guarding the POST route only — `createGenerateAuthMiddleware`. */
  auth: MiddlewareHandler;
  /** SSE poll interval; overridable so tests don't wait on a real timer. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * `Job` -> the shape sent down the wire on every SSE event. Deliberately
 * excludes `request`/`stageOutput` — internal orchestrator bookkeeping the
 * client has no use for and shouldn't have to parse around.
 */
function jobEventPayload(job: { status: string; stage: string | null; tourId: string | null; error: string | null }) {
  return {
    status: job.status,
    stage: job.stage,
    tourId: job.tourId,
    error: job.error,
  };
}

/**
 * The generation service's HTTP surface: kick off a job, watch it over SSE,
 * fetch the finished tour. Every route here reads or writes the durable job
 * row — see `orchestrator.ts` for why the actual generation work never runs
 * inside a request.
 */
export function createToursRouter(deps: ToursRouteDeps): Hono {
  const router = new Hono();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // 202 immediately; the pipeline is started detached (never awaited) below.
  // A phone that pockets itself the instant this resolves must not lose the
  // job — the job row is the only thing carrying it forward from here.
  router.post('/api/tours', deps.auth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = GenerateRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body.', issues: parsed.error.issues }, 400);
    }
    const request = parsed.data;

    const city = findCityConfig(request.city);
    if (!city) {
      return c.json({ error: `Unknown city "${request.city}".` }, 400);
    }

    const job = await deps.repo.createJob(city.slug, request);

    // Deliberately not awaited — see orchestrator.ts's module doc. Attaching
    // .catch() here is a last-resort net alongside runPipeline's own
    // internal one: this promise must never reject unhandled, because it
    // runs with nothing downstream of it awaiting the result.
    runPipeline(job.id, {
      repo: deps.repo,
      llm: deps.llm,
      fetch: deps.fetch,
      mapboxFetch: deps.mapboxFetch,
      mapboxToken: deps.mapboxToken,
      tts: deps.tts,
      audioStore: deps.audioStore,
    }).catch(async (err: unknown) => {
      try {
        await deps.repo.updateJob(job.id, {
          status: 'failed',
          error: scrubSecrets(err instanceof Error ? err.message : String(err)),
        });
      } catch {
        // Nothing more we can do without risking an unhandled rejection.
      }
    });

    return c.json({ jobId: job.id }, 202);
  });

  // Reconnectable SSE: the first event is always the job's CURRENT state,
  // never only subsequent changes. That is what makes reconnecting after a
  // phone wakes from sleep identical to connecting the first time — no
  // special case, no missed transitions to reconcile.
  router.get('/api/tours/:jobId/events', (c) => {
    const jobId = c.req.param('jobId');

    return streamSSE(c, async (stream) => {
      let lastSerialized: string | null = null;

      while (!c.req.raw.signal.aborted) {
        const job = await deps.repo.getJob(jobId);
        if (!job) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'Job not found.' }) });
          return;
        }

        const serialized = JSON.stringify(jobEventPayload(job));
        if (serialized !== lastSerialized) {
          await stream.writeSSE({ data: serialized });
          lastSerialized = serialized;
        }

        if (job.status === 'done' || job.status === 'failed') return;

        await stream.sleep(pollIntervalMs);
      }
    });
  });

  router.get('/api/tours/:tourId', async (c) => {
    const tour = await deps.repo.getTour(c.req.param('tourId'));
    if (!tour) return c.json({ error: 'Tour not found.' }, 404);
    return c.json(tour, 200);
  });

  return router;
}
