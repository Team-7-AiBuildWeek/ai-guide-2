// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CuratedStop, GenerateRequest, Poi } from '@ai-guide/shared';
import type { LlmClient, LlmResult, UserBlock } from './llm/anthropic.ts';
import { InMemoryTourRepository } from './db/memory.ts';
import { FileCassetteStore, cassetteFetch } from './cassette/index.ts';
import { createRedactingCassetteFetch } from './stages/routing/mapbox.ts';
import { discover } from './stages/discovery/index.ts';
import { runPipeline } from './orchestrator.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', 'cassettes');

function makeRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    city: 'Bratislava',
    profileText: 'brutalist architecture, and I hate crowds',
    language: 'sk',
    persona: 'a grumpy local historian',
    budgetMin: 90,
    ...overrides,
  };
}

function result(text: string, costUsd = 0): LlmResult {
  return { text, costUsd };
}

function unusedLive(): typeof fetch {
  return (async () => {
    throw new Error('replay must never call through to a live fetch');
  }) as unknown as typeof fetch;
}

/** Routes wikidata/wikipedia/overpass through plain cassette replay and
 * api.mapbox.com through the token-redacting one — the same split every
 * cassette-backed test in this repo uses, just combined into one `fetch`
 * for a caller (the orchestrator) that touches both in a single run. */
function combinedReplayFetch(): typeof fetch {
  const store = new FileCassetteStore(cassetteDir);
  const plain = cassetteFetch('replay', store, unusedLive());
  const mapbox = createRedactingCassetteFetch('replay', store, unusedLive());
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.includes('api.mapbox.com') ? mapbox(input, init) : plain(input, init);
  }) as typeof fetch;
}

/** Distinguishes a curation call from a narration call by its cacheable user
 * block's text — curation's starts with "Candidates:", narration's with
 * "Stops, in walking order" (see prompt.ts in each stage) — and serves
 * per-stage response queues so a test can fail narration specifically
 * without touching curation's count. */
class StageAwareStubLlmClient implements LlmClient {
  curationCalls = 0;
  narrationCalls = 0;
  private readonly curationResponses: LlmResult[];
  private readonly narrationResponses: LlmResult[];

  constructor(curationResponses: LlmResult[], narrationResponses: LlmResult[]) {
    this.curationResponses = curationResponses;
    this.narrationResponses = narrationResponses;
  }

  async complete(args: { system: string; userBlocks: UserBlock[]; maxTokens: number }): Promise<LlmResult> {
    const isCuration = args.userBlocks.some((b) => b.text.startsWith('Candidates:'));
    if (isCuration) {
      const i = Math.min(this.curationCalls, this.curationResponses.length - 1);
      this.curationCalls++;
      return this.curationResponses[i];
    }
    const i = Math.min(this.narrationCalls, this.narrationResponses.length - 1);
    this.narrationCalls++;
    return this.narrationResponses[i];
  }
}

/** Always throws for curation calls, to force a stage failure that isn't a
 * validation retry (curate() does not catch a rejected llm.complete — it
 * propagates straight out, unlike a structurally-invalid response). */
class ThrowingCurationLlmClient implements LlmClient {
  async complete(args: { system: string; userBlocks: UserBlock[]; maxTokens: number }): Promise<LlmResult> {
    if (args.userBlocks.some((b) => b.text.startsWith('Candidates:'))) {
      throw new Error('simulated Anthropic API failure');
    }
    throw new Error('unexpected call for this test');
  }
}

let curationFixture: { tourTitle: string; stops: CuratedStop[] };
let narrationFixture: { segments: unknown[] };
let realBratislavaPois: Poi[];

beforeAll(async () => {
  curationFixture = JSON.parse(
    await readFile(join(cassetteDir, 'synthetic', 'curation-bratislava.json'), 'utf8'),
  );
  narrationFixture = JSON.parse(
    await readFile(join(cassetteDir, 'synthetic', 'narration-bratislava-sk.json'), 'utf8'),
  );
  realBratislavaPois = await discover(
    { slug: 'bratislava', name: 'Bratislava', localLanguage: 'sk', centre: { lat: 48.1436, lng: 17.1085 }, radiusM: 1000 },
    { fetch: cassetteFetch('replay', new FileCassetteStore(cassetteDir), unusedLive()) },
  );
});

function validCurationResponseText(): string {
  return JSON.stringify({ tourTitle: curationFixture.tourTitle, stops: curationFixture.stops });
}

function validNarrationResponseText(): string {
  return JSON.stringify({ segments: narrationFixture.segments });
}

// Real cassette replay (discovery's Wikidata/Wikipedia/Overpass calls, plus
// narration's own Wikipedia extract fetches) carries the same courtesy
// delays the live APIs require in production, so a run that touches
// discovery routinely takes a few seconds — well past vitest's default
// per-test timeout.
const CASSETTE_TEST_TIMEOUT_MS = 20_000;

describe('runPipeline — happy path (recorded Bratislava cassettes)', () => {
  it(
    'runs discovery, curation, routing and narration end-to-end and marks the job done with a tourId',
    async () => {
      const repo = new InMemoryTourRepository();
      const job = await repo.createJob('bratislava', makeRequest());
      const llm = new StageAwareStubLlmClient([result(validCurationResponseText(), 0.03)], [result(validNarrationResponseText(), 0.05)]);

      await runPipeline(job.id, { repo, llm, fetch: combinedReplayFetch(), mapboxToken: 'unused-in-replay' });

      const finished = await repo.getJob(job.id);
      expect(finished?.status).toBe('done');
      expect(finished?.stage).toBe('narration');
      expect(finished?.tourId).toBeTruthy();
      expect(finished?.error).toBeNull();

      const tour = await repo.getTour(finished!.tourId!);
      expect(tour).toBeTruthy();
      expect(tour?.segments.length).toBe(2 * curationFixture.stops.length + 1);
    },
    CASSETTE_TEST_TIMEOUT_MS,
  );

  it(
    'accumulates cost across the curation and narration LLM calls onto the job',
    async () => {
      const repo = new InMemoryTourRepository();
      const job = await repo.createJob('bratislava', makeRequest());
      const llm = new StageAwareStubLlmClient([result(validCurationResponseText(), 0.03)], [result(validNarrationResponseText(), 0.05)]);

      await runPipeline(job.id, { repo, llm, fetch: combinedReplayFetch(), mapboxToken: 'unused-in-replay' });

      const finished = await repo.getJob(job.id);
      expect(finished?.costUsd).toBeCloseTo(0.08, 10);
    },
    CASSETTE_TEST_TIMEOUT_MS,
  );

  it(
    'does not call discover() when the city already has cached POIs',
    async () => {
      const repo = new InMemoryTourRepository();
      await repo.savePois('bratislava', realBratislavaPois);
      const job = await repo.createJob('bratislava', makeRequest());
      const llm = new StageAwareStubLlmClient([result(validCurationResponseText())], [result(validNarrationResponseText())]);

      // Blocks only the Wikidata SPARQL endpoint — the one call `discover()`
      // always makes first (`fetchWikidataCandidates`) and narration never
      // does. Wikipedia and Overpass stay live (via replay) because
      // narration's own `fetchStopExtracts` legitimately calls Wikipedia
      // regardless of whether discovery ran. A job that still finishes
      // proves `discover()` itself was never invoked.
      const withoutWikidata: typeof fetch = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes('query.wikidata.org')) {
          throw new Error(`discover() must not run for a city with cached POIs — unexpected fetch to ${url}`);
        }
        return combinedReplayFetch()(input, init);
      }) as typeof fetch;

      await runPipeline(job.id, { repo, llm, fetch: withoutWikidata, mapboxToken: 'unused-in-replay' });

      const finished = await repo.getJob(job.id);
      expect(finished?.status).toBe('done');
    },
    CASSETTE_TEST_TIMEOUT_MS,
  );
});

describe('runPipeline — failure handling', () => {
  it('never throws, and marks the job failed with the failing stage and a message', async () => {
    const repo = new InMemoryTourRepository();
    await repo.savePois('bratislava', realBratislavaPois);
    const job = await repo.createJob('bratislava', makeRequest());
    const llm = new ThrowingCurationLlmClient();

    await expect(
      runPipeline(job.id, { repo, llm, fetch: combinedReplayFetch(), mapboxToken: 'unused-in-replay' }),
    ).resolves.toBeUndefined();

    const finished = await repo.getJob(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.stage).toBe('curation');
    expect(finished?.error).toContain('simulated Anthropic API failure');
  });
});

describe('runPipeline — retry resumes from the failed stage', () => {
  it(
    'a narration failure followed by a retry does not re-run curation',
    async () => {
      const repo = new InMemoryTourRepository();
      await repo.savePois('bratislava', realBratislavaPois);
      const job = await repo.createJob('bratislava', makeRequest());

      // Curation succeeds once; narration fails its 2 attempts (invalid JSON
      // shape both times) on the first run, then succeeds on the retry.
      const invalidNarration = result(JSON.stringify({ segments: [] }));
      const llm = new StageAwareStubLlmClient(
        [result(validCurationResponseText())],
        [invalidNarration, invalidNarration, result(validNarrationResponseText())],
      );
      const deps = { repo, llm, fetch: combinedReplayFetch(), mapboxToken: 'unused-in-replay' };

      await runPipeline(job.id, deps);
      const afterFirstRun = await repo.getJob(job.id);
      expect(afterFirstRun?.status).toBe('failed');
      expect(afterFirstRun?.stage).toBe('narration');
      expect(llm.curationCalls).toBe(1);
      expect(llm.narrationCalls).toBe(2);

      await runPipeline(job.id, deps);
      const afterRetry = await repo.getJob(job.id);
      expect(afterRetry?.status).toBe('done');
      expect(afterRetry?.tourId).toBeTruthy();

      // The point of the whole test: curation was not re-paid for.
      expect(llm.curationCalls).toBe(1);
      expect(llm.narrationCalls).toBe(3);
    },
    CASSETTE_TEST_TIMEOUT_MS,
  );
});

describe('runPipeline — over-budget routing', () => {
  function makeSpacedPois(n: number): Poi[] {
    return Array.from({ length: n }, (_, i) => ({
      wikidataQid: `Q${2_000_000 + i}`,
      names: { en: `Landmark ${i}` },
      point: { lat: 48.14 + i * 0.0015, lng: 17.105 },
      p31Types: ['square'],
      wikiEnTitle: null,
      wikiLocalTitle: null,
      summaryEn: null,
      summaryLocal: null,
      wheelchair: null,
    }));
  }

  function stopsFromPois(pois: Poi[]): CuratedStop[] {
    return pois.slice(0, 8).map((p, i) => ({
      wikidataQids: [p.wikidataQid],
      standingPoint: p.point,
      title: p.names.en,
      why: 'A representative stop.',
      order: i,
    }));
  }

  function farApartNarrationSegments(stopCount: number): unknown[] {
    const segments: { order: number; kind: string; title: string; script: string }[] = [];
    let order = 0;
    segments.push({ order: order++, kind: 'intro', title: 'Intro', script: 'x'.repeat(200) });
    for (let i = 0; i < stopCount; i++) {
      segments.push({ order: order++, kind: 'stop', title: `Stop ${i}`, script: 'x'.repeat(500) });
      if (i < stopCount - 1) {
        segments.push({ order: order++, kind: 'walk', title: `Walk ${i}`, script: 'x'.repeat(150) });
      }
    }
    segments.push({ order: order++, kind: 'outro', title: 'Outro', script: 'x'.repeat(200) });
    return segments;
  }

  it('re-runs curation exactly once when the route comes back over budget, then proceeds even if still over', async () => {
    const pois = makeSpacedPois(10);
    const stops = stopsFromPois(pois);
    const curationText = JSON.stringify({ tourTitle: 'Over-budget Tour', stops });
    const narrationText = JSON.stringify({ segments: farApartNarrationSegments(stops.length) });

    const repo = new InMemoryTourRepository();
    await repo.savePois('bratislava', pois);
    const job = await repo.createJob('bratislava', makeRequest({ budgetMin: 90 }));

    const llm = new StageAwareStubLlmClient(
      [result(curationText), result(curationText)],
      [result(narrationText)],
    );

    let mapboxCalls = 0;
    // A hugely over-long route no matter the stops — every call reports the
    // same enormous duration, so if the orchestrator looped it would show up
    // as more than 2 mapbox calls.
    const fetchImpl: typeof fetch = (async () => {
      mapboxCalls++;
      const body = {
        code: 'Ok',
        routes: [
          {
            distance: 50000,
            duration: 50000,
            geometry: { type: 'LineString', coordinates: [[17.1, 48.14], [17.11, 48.15]] },
            legs: Array.from({ length: stops.length - 1 }, () => ({ distance: 5000 / (stops.length - 1), duration: 50000 / (stops.length - 1) })),
          },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    await runPipeline(job.id, { repo, llm, fetch: fetchImpl, mapboxToken: 'tok' });

    const finished = await repo.getJob(job.id);
    expect(finished?.status).toBe('done');
    expect(llm.curationCalls).toBe(2); // exactly one re-curation, never a loop
    expect(mapboxCalls).toBe(2); // route, then re-route — no third call
  });
});
