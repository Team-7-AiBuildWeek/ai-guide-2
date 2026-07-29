// @vitest-environment node
//
// ONE contract suite, run against both TourRepository implementations. This
// is the structural point of task 9: write the tests once so the
// in-memory implementation cannot quietly drift from what the real
// Postgres one actually does.
//
// The postgres row is skipped (via it.skipIf) unless DATABASE_URL is set
// AND reachable — see apps/api/scripts/apply-schema.ts for applying the
// schema first. Reachability is checked with a real "select 1", not just
// whether the env var is set: Supabase's direct connection hostname
// (db.<ref>.supabase.co) is IPv6-only, and on a network with no IPv6 route
// (as of this writing, the dev machine this suite normally runs on) a bad
// URL must fail fast rather than hang the whole suite — see
// PostgresTourRepository's connectionTimeoutMillis. When postgres IS
// reachable, every test below cleans up after itself: all rows are scoped
// under a distinctive per-run city slug, and afterAll deletes that city,
// which cascades to every job/tour/segment/poi row the suite created.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { GenerateRequest, Poi, Tour } from '@ai-guide/shared';
import { InMemoryTourRepository } from './memory.ts';
import { PostgresTourRepository } from './postgres.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', '..', '..', 'packages', 'shared', 'src', 'fixtures', 'bratislava-tour.json');

async function isReachable(connectionString: string): Promise<boolean> {
  const probe = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await probe.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

const databaseUrl = process.env.DATABASE_URL;
// Top-level await: resolved once, before describe.each builds the suite, so
// every it.skipIf(...) below sees a real yes/no rather than "env var is set"
// (which would let an unreachable URL hang or fail every single test).
const postgresAvailable = databaseUrl ? await isReachable(databaseUrl) : false;

function makeRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    city: 'Bratislava',
    profileText: 'brutalist architecture',
    language: 'sk',
    persona: 'a grumpy local historian',
    budgetMin: 90,
    ...overrides,
  };
}

function makePoi(qid: string, overrides: Partial<Poi> = {}): Poi {
  return {
    wikidataQid: qid,
    names: { en: `POI ${qid}` },
    point: { lat: 48.1486, lng: 17.1077 },
    p31Types: ['Q570116'],
    wikiEnTitle: null,
    wikiLocalTitle: null,
    summaryEn: null,
    summaryLocal: null,
    wheelchair: null,
    ...overrides,
  };
}

type Repo = InMemoryTourRepository | PostgresTourRepository;
type Factory = () => Repo | null;

const repositories: [string, Factory][] = [
  ['memory', () => new InMemoryTourRepository()],
  ['postgres', () => (postgresAvailable ? new PostgresTourRepository(databaseUrl!) : null)],
];

describe.each(repositories)('%s repository', (name, make) => {
  const repo = make();
  const citySlug = `test-${name}-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    if (repo instanceof PostgresTourRepository) {
      await repo._deleteCityForTest(citySlug);
      await repo.close();
    }
  });

  it.skipIf(repo === null)('round-trips a job through create/get', async () => {
    const r = repo!;
    const request = makeRequest();
    const created = await r.createJob(citySlug, request);

    expect(created.status).toBe('queued');
    expect(created.stage).toBeNull();
    expect(created.tourId).toBeNull();
    expect(created.error).toBeNull();
    expect(created.costUsd).toBe(0);
    expect(created.request).toEqual(request);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const fetched = await r.getJob(created.id);
    expect(fetched).toEqual(created);
  });

  it.skipIf(repo === null)('getJob returns null for an unknown (but validly formed) id, not a throw', async () => {
    const r = repo!;
    await expect(r.getJob(randomUUID())).resolves.toBeNull();
  });

  it.skipIf(repo === null)('updateJob patches fields, advances updatedAt, and leaves createdAt alone', async () => {
    const r = repo!;
    const created = await r.createJob(citySlug, makeRequest());
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await r.updateJob(created.id, {
      status: 'running',
      stage: 'discovery',
      stageOutput: { pois: 4 },
      costUsd: 0.12,
    });

    expect(updated.status).toBe('running');
    expect(updated.stage).toBe('discovery');
    expect(updated.stageOutput).toEqual({ pois: 4 });
    expect(updated.costUsd).toBe(0.12);
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());

    const fetched = await r.getJob(created.id);
    expect(fetched).toEqual(updated);
  });

  it.skipIf(repo === null)('savePois is idempotent for the same QID (upsert, not a duplicate-key error)', async () => {
    const r = repo!;
    const poi = makePoi('Q999001', { summaryEn: 'first summary' });

    await r.savePois(citySlug, [poi]);
    await r.savePois(citySlug, [{ ...poi, summaryEn: 'second summary' }]);

    const pois = await r.getPois(citySlug);
    const matches = pois.filter((p) => p.wikidataQid === 'Q999001');
    expect(matches).toHaveLength(1);
    expect(matches[0].summaryEn).toBe('second summary');
  });

  it.skipIf(repo === null)('getPois returns [] for a city with no saved POIs', async () => {
    const r = repo!;
    await expect(r.getPois(`${citySlug}-unused`)).resolves.toEqual([]);
  });

  it.skipIf(repo === null)(
    'a tour round-trips with all of its segments, preserving order, poiIds, null intro/outro triggers, and triggerRadiusM',
    async () => {
      const r = repo!;
      const fixtureRaw = await readFile(fixturePath, 'utf8');
      const fixture = JSON.parse(fixtureRaw) as { tour: Tour };
      const expectedSegmentCount = fixture.tour.segments.length;

      // tours.id is a real `uuid` column (unlike segments.id, which is
      // `text` for exactly this reason — see schema.sql's comment), so the
      // fixture's human-readable id can't be used verbatim. city is
      // overridden to the distinctive test slug so cleanup stays scoped to
      // rows this test created, never the real "Bratislava" city.
      const testTourId = randomUUID();
      const testTour: Tour = {
        ...fixture.tour,
        id: testTourId,
        city: citySlug,
        segments: fixture.tour.segments.map((seg) => ({ ...seg, id: `${testTourId}-${seg.id}` })),
      };

      await r.saveTour(testTour);
      const fetched = await r.getTour(testTourId);

      expect(fetched).not.toBeNull();
      const tour = fetched!;

      expect(tour.title).toBe(testTour.title);
      expect(tour.language).toBe(testTour.language);
      expect(tour.persona).toBe(testTour.persona);
      expect(tour.routeGeoJson).toEqual(testTour.routeGeoJson);
      expect(tour.segments).toHaveLength(expectedSegmentCount);
      expect(tour.segments.map((s) => s.order)).toEqual(testTour.segments.map((s) => s.order));

      for (let i = 0; i < testTour.segments.length; i++) {
        const expected = testTour.segments[i];
        const actual = tour.segments[i];

        expect(actual.kind).toBe(expected.kind);
        expect(actual.poiIds).toEqual(expected.poiIds);
        expect(actual.triggerRadiusM).toBe(expected.triggerRadiusM);
        expect(actual.audioUrl).toBeNull();
        expect(actual.durationMs).toBeNull();

        if (expected.kind === 'intro' || expected.kind === 'outro') {
          expect(actual.trigger).toBeNull();
        } else {
          expect(actual.trigger).not.toBeNull();
          // Guards ST_MakePoint's lng-first argument order: swapping it
          // would put this point in the Indian Ocean, not just introduce a
          // rounding error, so a 6-decimal-place check catches it clearly.
          expect(actual.trigger!.lat).toBeCloseTo(expected.trigger!.lat, 6);
          expect(actual.trigger!.lng).toBeCloseTo(expected.trigger!.lng, 6);
        }
      }
    },
  );

  it.skipIf(repo === null)('getTour returns null for an unknown id, not a throw', async () => {
    const r = repo!;
    await expect(r.getTour(randomUUID())).resolves.toBeNull();
  });

  it.skipIf(repo === null)(
    'spendTodayUsd returns a number and sums 0.46 + 0.46 to 0.92, not string concatenation',
    async () => {
      const r = repo!;
      const before = await r.spendTodayUsd();

      const jobA = await r.createJob(citySlug, makeRequest());
      const jobB = await r.createJob(citySlug, makeRequest());
      await r.updateJob(jobA.id, { costUsd: 0.46 });
      await r.updateJob(jobB.id, { costUsd: 0.46 });

      const spend = await r.spendTodayUsd();
      expect(typeof spend).toBe('number');
      expect(String(spend)).not.toBe('0.460.46');
      expect(spend).toBeCloseTo(before + 0.92, 4);
    },
  );

  it.skipIf(repo === null)('spendTodayUsd excludes jobs not created today', async () => {
    const r = repo!;
    const before = await r.spendTodayUsd();

    const oldJob = await r.createJob(citySlug, makeRequest());
    await r.updateJob(oldJob.id, { costUsd: 5 });
    await r.spendTodayUsd(); // sanity: the job counts before it's backdated
    await expect(r.spendTodayUsd()).resolves.toBeCloseTo(before + 5, 4);

    await r._setJobCreatedAtForTest(oldJob.id, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));

    await expect(r.spendTodayUsd()).resolves.toBeCloseTo(before, 4);
  });
});
