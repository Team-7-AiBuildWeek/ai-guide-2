import { randomUUID } from 'node:crypto';
import type { CurationOutput, Poi } from '@ai-guide/shared';
import type { Job, JobStage, TourRepository } from './db/repository.ts';
import type { LlmClient } from './llm/anthropic.ts';
import { findCityConfig } from './config/cities.ts';
import { discover } from './stages/discovery/index.ts';
import { curate } from './stages/curation/index.ts';
import { route, type RouteResult } from './stages/routing/index.ts';
import { narrate, fetchStopExtracts, assembleTour } from './stages/narration/index.ts';
import { scrubSecrets } from './scrub.ts';

export interface OrchestratorDeps {
  repo: TourRepository;
  llm: LlmClient;
  fetch: typeof fetch;
  /**
   * Fetch used for Mapbox Directions only.
   *
   * Mapbox carries its credential as a URL query parameter, so the URL that
   * reaches the cassette layer must have the token stripped before a key is
   * derived from it — see `createRedactingCassetteFetch`. Keeping it a
   * separate dependency rather than reusing `fetch` is deliberate: when the
   * service wired the generic fetch through to routing, recordings (made via
   * the redacting path, keyed on `access_token=REDACTED`) and the running
   * service (keyed on the real token) disagreed on every key, so routing
   * missed its cassette and printed the token in the error. Tests and
   * recording scripts agreed with each other while both disagreed with the
   * app.
   *
   * Falls back to `fetch` so existing callers keep working; production wiring
   * must pass the redacting one.
   */
  mapboxFetch?: typeof fetch;
  mapboxToken: string;
}

/**
 * How much a re-curation after an over-budget route is allowed to shave off
 * the target, beyond the plain overage: keeps the retried request honest
 * about how far over it actually was, without asking curation to do
 * something a single stop's dwell time (~a few minutes) can't fix even when
 * the model complies exactly.
 */
const MIN_BUDGET_MIN = 20;

/**
 * The per-job durable record of what each stage produced, keyed by stage
 * name. Stored on `job.stageOutput` and written after every stage completes
 * — this is what lets a retry skip straight to the failed stage instead of
 * re-paying for everything before it.
 */
interface StageOutput {
  discovery?: { pois: Poi[] };
  curation?: { output: CurationOutput; costUsd: number };
  routing?: { output: CurationOutput; costUsd: number; result: RouteResult };
}

/**
 * `Job.stageOutput` is `Record<string, unknown>` — untyped storage, because
 * it is whatever JSON the repository round-trips through Postgres `jsonb`.
 * This is the one place that reads/writes it against the shape the
 * orchestrator actually agrees on with itself; every other stage sees typed
 * values only.
 */
function stageOutputOf(job: Job): StageOutput {
  return job.stageOutput as StageOutput;
}

/**
 * Runs the four generation stages against a durable job row, writing
 * `stage`/`stageOutput` after each one completes so a retry can resume from
 * wherever it left off instead of re-paying for everything before it.
 *
 * Deliberately never throws — see `runPipeline`, the only public entry
 * point, which wraps this in a last-resort try/catch. This function runs
 * detached from the request that started it (generation takes about a
 * minute and phones sleep well before that), so an exception here would
 * become an unhandled rejection and take the whole process down.
 */
async function runPipelineInner(jobId: string, deps: OrchestratorDeps): Promise<void> {
  const { repo, llm, fetch: fetchImpl, mapboxToken } = deps;
  const mapboxFetch = deps.mapboxFetch ?? fetchImpl;

  const job = await repo.getJob(jobId);
  if (!job) {
    throw new Error(`runPipeline: no job with id "${jobId}".`);
  }
  if (job.status === 'done') {
    // Nothing to do — most likely a duplicate detached call. Re-running a
    // finished job would re-spend money for no reason. Deliberately NOT
    // guarding on 'failed' here: a failed job's status IS the retry entry
    // point, and returning early for it would silently no-op every retry.
    return;
  }

  const city = findCityConfig(job.request.city);
  if (!city) {
    await fail(repo, jobId, job.costUsd, 'discovery', new Error(`Unknown city "${job.request.city}".`));
    return;
  }

  const stageOutput = stageOutputOf(job);
  let costUsd = job.costUsd;

  // ---- Stage 1: discovery — per-city, cached, never in the per-tour path
  // once a city is known. ----
  let pois: Poi[];
  if (stageOutput.discovery) {
    pois = stageOutput.discovery.pois;
  } else {
    try {
      pois = await repo.getPois(city.slug);
      if (pois.length === 0) {
        pois = await discover(city, { fetch: fetchImpl });
        await repo.savePois(city.slug, pois);
      }
    } catch (err) {
      await fail(repo, jobId, costUsd, 'discovery', err);
      return;
    }
    stageOutput.discovery = { pois };
    await repo.updateJob(jobId, {
      status: 'running',
      stage: 'discovery',
      stageOutput: { ...stageOutput } as Record<string, unknown>,
      costUsd,
    });
  }

  // ---- Stage 2: curation ----
  let curationResult: { output: CurationOutput; costUsd: number };
  if (stageOutput.curation) {
    curationResult = stageOutput.curation;
  } else {
    try {
      curationResult = await curate(pois, job.request, { llm });
    } catch (err) {
      await fail(repo, jobId, costUsd, 'curation', err);
      return;
    }
    costUsd += curationResult.costUsd;
    stageOutput.curation = curationResult;
    await repo.updateJob(jobId, {
      status: 'running',
      stage: 'curation',
      stageOutput: { ...stageOutput } as Record<string, unknown>,
      costUsd,
    });
  }

  // ---- Stage 3: routing — one bounded re-curation if the route comes back
  // over budget, never a loop. ----
  let routeResult: RouteResult;
  if (stageOutput.routing) {
    curationResult = { output: stageOutput.routing.output, costUsd: stageOutput.routing.costUsd };
    routeResult = stageOutput.routing.result;
  } else {
    try {
      routeResult = await route(curationResult.output.stops, job.request.budgetMin, {
        fetch: mapboxFetch,
        token: mapboxToken,
      });

      if (routeResult.overBudget) {
        const overageMin = Math.max(0, routeResult.estimatedMin - job.request.budgetMin);
        const adjustedBudgetMin = Math.max(MIN_BUDGET_MIN, Math.round(job.request.budgetMin - overageMin));
        const recurated = await curate(pois, { ...job.request, budgetMin: adjustedBudgetMin }, { llm });
        costUsd += recurated.costUsd;
        curationResult = recurated;

        // Route again against the ORIGINAL budget so `overBudget` still
        // means what the traveller asked for, not the adjusted target we
        // nudged curation toward. If it is still over, we proceed anyway
        // and record it — this is the one retry, not a loop.
        routeResult = await route(recurated.output.stops, job.request.budgetMin, {
          // mapboxFetch, not fetchImpl. This second call is the one a
          // find-and-replace missed, and because it only runs on the
          // over-budget path it stayed invisible: every test and every manual
          // check used a 60-minute budget against a ~35-minute tour, so the
          // re-curation branch never executed.
          fetch: mapboxFetch,
          token: mapboxToken,
        });
      }
    } catch (err) {
      await fail(repo, jobId, costUsd, 'routing', err);
      return;
    }
    stageOutput.curation = curationResult;
    stageOutput.routing = { output: curationResult.output, costUsd: curationResult.costUsd, result: routeResult };
    await repo.updateJob(jobId, {
      status: 'running',
      stage: 'routing',
      stageOutput: { ...stageOutput } as Record<string, unknown>,
      costUsd,
    });
  }

  // ---- Stage 4: narration -> assemble -> save ----
  try {
    const stops = curationResult.output.stops;
    const extracts = await fetchStopExtracts(stops, pois, city, { fetch: fetchImpl });
    const narrationResult = await narrate(stops, extracts, routeResult, job.request, { llm });
    costUsd += narrationResult.costUsd;

    const tourId = randomUUID();
    const tour = assembleTour({
      tourId,
      tourTitle: curationResult.output.tourTitle,
      city: city.name,
      request: job.request,
      stops,
      route: routeResult,
      narration: narrationResult.output,
    });
    await repo.saveTour(tour);

    await repo.updateJob(jobId, {
      status: 'done',
      stage: 'narration',
      stageOutput: { ...stageOutput } as Record<string, unknown>,
      costUsd,
      tourId,
    });
  } catch (err) {
    await fail(repo, jobId, costUsd, 'narration', err);
  }
}

async function fail(
  repo: TourRepository,
  jobId: string,
  costUsd: number,
  stage: JobStage,
  err: unknown,
): Promise<void> {
  // Every stage failure funnels through here, so this is the scrub that
  // actually matters — the two call sites patched earlier were the rarer
  // paths, and a Mapbox URL still reached the database and the browser
  // through this one.
  const message = scrubSecrets(err instanceof Error ? err.message : String(err));
  await repo.updateJob(jobId, { status: 'failed', stage, error: message, costUsd });
}

/**
 * Runs the generation pipeline for `jobId` against the durable job row,
 * never throwing.
 *
 * This is the whole reason the design looks the way it does: generation
 * takes about a minute and a phone screen sleeping suspends the tab and
 * kills any open connection, so the work cannot live inside the request that
 * started it. `routes/tours.ts` calls this detached (no `await`) and returns
 * 202 immediately; the SSE endpoint is only ever a read-only view onto the
 * row this function writes. Because it is detached, an exception escaping it
 * would surface as an unhandled promise rejection and take the whole Node
 * process down — so every failure path inside `runPipelineInner` is caught
 * and turned into a `status: 'failed'` row instead, and this wrapper is a
 * last-resort net around that for anything that isn't (e.g. the initial
 * `getJob`, or a failure writing the failure itself).
 */
export async function runPipeline(jobId: string, deps: OrchestratorDeps): Promise<void> {
  try {
    await runPipelineInner(jobId, deps);
  } catch (err) {
    try {
      await deps.repo.updateJob(jobId, {
        status: 'failed',
        error: scrubSecrets(err instanceof Error ? err.message : String(err)),
      });
    } catch {
      // There is truly nothing more we can do here without risking throwing
      // out of a detached call — swallow so the process stays up.
    }
  }
}
