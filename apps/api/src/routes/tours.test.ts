// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { GenerateRequest, LineString, Tour } from '@ai-guide/shared';
import type { LlmClient, LlmResult, UserBlock } from '../llm/anthropic.ts';
import { InMemoryTourRepository } from '../db/memory.ts';
import { createGenerateAuthMiddleware } from '../auth.ts';
import { createToursRouter } from './tours.ts';

const PASSPHRASE = 'sesame';

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${PASSPHRASE}`, 'content-type': 'application/json' };
}

function makeGenerateBody(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    city: 'Bratislava',
    profileText: 'brutalist architecture, and I hate crowds',
    language: 'en',
    persona: 'a grumpy local historian',
    budgetMin: 90,
    ...overrides,
  };
}

/** Never legitimately called in a test that reaches for it — any invocation
 * means a route did something it shouldn't (e.g. a GET calling the LLM). */
class UnusedLlmClient implements LlmClient {
  async complete(): Promise<LlmResult> {
    throw new Error('LlmClient.complete should not be called in this test.');
  }
}

/** A stub whose `complete()` hangs until the test resolves it — the
 * mechanism for proving POST returns before the pipeline finishes: the
 * pipeline blocks on this call (curation, reached right after discovery,
 * which is skipped by pre-seeding cached POIs) for as long as the test
 * wants. */
class BlockingLlmClient implements LlmClient {
  private resolveFn: ((r: LlmResult) => void) | null = null;
  private readonly promise: Promise<LlmResult>;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  async complete(_args: { system: string; userBlocks: UserBlock[]; maxTokens: number }): Promise<LlmResult> {
    return this.promise;
  }

  /** Lets a blocked pipeline drain after the test's assertions are done, so
   * nothing is left dangling once the test finishes. */
  release(r: LlmResult): void {
    this.resolveFn?.(r);
  }
}

function buildRouter(overrides: {
  repo?: InMemoryTourRepository;
  llm?: LlmClient;
  fetch?: typeof fetch;
  mapboxToken?: string;
  pollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const repo = overrides.repo ?? new InMemoryTourRepository();
  const auth = createGenerateAuthMiddleware({ repo, env: overrides.env ?? { GENERATE_PASSPHRASE: PASSPHRASE } });
  const router = createToursRouter({
    repo,
    llm: overrides.llm ?? new UnusedLlmClient(),
    fetch: overrides.fetch ?? fetch,
    mapboxToken: overrides.mapboxToken ?? 'unused',
    auth,
    pollIntervalMs: overrides.pollIntervalMs,
  });
  return { repo, router };
}

const FAKE_LINE: LineString = { type: 'LineString', coordinates: [[17.1, 48.14]] };

function makeFakeTour(id: string): Tour {
  return {
    id,
    city: 'Bratislava',
    language: 'en',
    persona: 'a grumpy local historian',
    profileText: 'brutalist architecture',
    title: 'Test Tour',
    segments: [],
    routeGeoJson: FAKE_LINE,
    estimatedDurationMin: 42,
  };
}

describe('POST /api/tours', () => {
  it('rejects a request without the passphrase', async () => {
    const { router } = buildRouter();
    const res = await router.request('/api/tours', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeGenerateBody()),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 with the Zod issues for an invalid body', async () => {
    const { router } = buildRouter();
    const res = await router.request('/api/tours', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ city: '' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown };
    expect(body.issues).toBeDefined();
  });

  it('returns 429 once the daily spend cap is reached', async () => {
    const repo = new InMemoryTourRepository();
    const priorJob = await repo.createJob('bratislava', makeGenerateBody());
    await repo.updateJob(priorJob.id, { costUsd: 5 });
    const { router } = buildRouter({ repo, env: { GENERATE_PASSPHRASE: PASSPHRASE, DAILY_SPEND_CAP_USD: '5' } });

    const res = await router.request('/api/tours', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeGenerateBody()),
    });
    expect(res.status).toBe(429);
  });

  it('returns 202 and a jobId before the pipeline finishes — the request never awaits generation', async () => {
    const repo = new InMemoryTourRepository();
    // Pre-seed the city's POIs so discovery is a cache hit and the very
    // next thing the pipeline does is call the LLM for curation, which is
    // where BlockingLlmClient holds it.
    await repo.savePois('bratislava', [
      {
        wikidataQid: 'Q1',
        names: { en: 'Landmark' },
        point: { lat: 48.14, lng: 17.1 },
        p31Types: ['square'],
        wikiEnTitle: null,
        wikiLocalTitle: null,
        summaryEn: null,
        summaryLocal: null,
        wheelchair: null,
      },
    ]);
    const llm = new BlockingLlmClient();
    const { router } = buildRouter({ repo, llm });

    const started = Date.now();
    const res = await router.request('/api/tours', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeGenerateBody()),
    });
    const elapsedMs = Date.now() - started;

    expect(res.status).toBe(202);
    expect(elapsedMs).toBeLessThan(500);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBeTruthy();

    // The pipeline is still blocked inside curation's LLM call — proof the
    // 202 above did not wait for it.
    const job = await repo.getJob(body.jobId);
    expect(job?.status).not.toBe('done');
    expect(job?.status).not.toBe('failed');

    // Let the blocked call drain so nothing is left running after the test.
    llm.release({ text: 'not valid json — lets this fail fast during cleanup', costUsd: 0 });
  });
});

describe('GET /api/tours/:jobId/events', () => {
  it('emits a terminal event immediately for an already-finished job — the reconnect-after-sleep path', async () => {
    const repo = new InMemoryTourRepository();
    const job = await repo.createJob('bratislava', makeGenerateBody());
    await repo.updateJob(job.id, { status: 'done', stage: 'narration', tourId: 'tour-123' });
    const { router } = buildRouter({ repo, pollIntervalMs: 20 });

    const res = await router.request(`/api/tours/${job.id}/events`);

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('connection')).toContain('keep-alive');

    const text = await res.text();
    const dataLines = text.split('\n').filter((line) => line.startsWith('data: '));
    // Exactly one event: connecting to an already-finished job must produce
    // the terminal state and nothing else — no state change ever occurs.
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain('"status":"done"');
    expect(dataLines[0]).toContain('tour-123');
  });

  it('returns a not-found event for an unknown jobId without hanging', async () => {
    const { router } = buildRouter({ pollIntervalMs: 20 });
    const res = await router.request('/api/tours/does-not-exist/events');
    const text = await res.text();
    expect(text).toContain('Job not found');
  });
});

describe('GET /api/tours/:tourId', () => {
  it('returns 200 with the tour when it exists', async () => {
    const repo = new InMemoryTourRepository();
    const tour = makeFakeTour('tour-abc');
    await repo.saveTour(tour);
    const { router } = buildRouter({ repo });

    const res = await router.request('/api/tours/tour-abc');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Tour;
    expect(body.id).toBe('tour-abc');
  });

  it('returns 404 when the tour does not exist', async () => {
    const { router } = buildRouter();
    const res = await router.request('/api/tours/does-not-exist');
    expect(res.status).toBe(404);
  });
});
