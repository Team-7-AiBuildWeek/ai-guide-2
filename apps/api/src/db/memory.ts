import { randomUUID } from 'node:crypto';
import type { GenerateRequest, Poi, Tour } from '@ai-guide/shared';
import type { Job, TourRepository } from './repository.ts';

/** True if `a` and `b` fall on the same calendar day in UTC. Matches
 * PostgresTourRepository's `spendTodayUsd`, which compares dates in UTC
 * rather than trusting the session's local timezone. */
function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * In-memory `TourRepository` for tests. Deliberately mirrors
 * `PostgresTourRepository`'s observable behaviour rather than the more
 * convenient exact semantics a bare `Map` would give for free — see
 * `saveTour`, where `estimated_duration_min` is rounded to match the
 * schema's `integer` column. `repository.test.ts` runs the same contract
 * suite against both implementations specifically to catch the case where
 * this one quietly diverges from the real one.
 */
export class InMemoryTourRepository implements TourRepository {
  private jobs = new Map<string, Job>();
  private tours = new Map<string, Tour>();
  private pois = new Map<string, Map<string, Poi>>();

  async createJob(cityId: string, request: GenerateRequest): Promise<Job> {
    const now = new Date();
    const job: Job = {
      id: randomUUID(),
      cityId,
      status: 'queued',
      stage: null,
      request: structuredClone(request),
      stageOutput: {},
      tourId: null,
      error: null,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  async getJob(id: string): Promise<Job | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async updateJob(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Promise<Job> {
    const existing = this.jobs.get(id);
    if (!existing) {
      throw new Error(`updateJob: no job with id "${id}"`);
    }
    const updated: Job = { ...existing, ...patch, updatedAt: new Date() };
    this.jobs.set(id, updated);
    return structuredClone(updated);
  }

  async saveTour(tour: Tour): Promise<void> {
    // `tours.estimated_duration_min` is `integer` in schema.sql, so
    // PostgresTourRepository must round it; round here too so the two
    // implementations agree on what a "saved tour" looks like.
    const stored: Tour = {
      ...structuredClone(tour),
      estimatedDurationMin: Math.round(tour.estimatedDurationMin),
    };
    this.tours.set(tour.id, stored);
  }

  async getTour(id: string): Promise<Tour | null> {
    const tour = this.tours.get(id);
    return tour ? structuredClone(tour) : null;
  }

  async savePois(citySlug: string, pois: Poi[]): Promise<void> {
    let byQid = this.pois.get(citySlug);
    if (!byQid) {
      byQid = new Map();
      this.pois.set(citySlug, byQid);
    }
    for (const poi of pois) {
      byQid.set(poi.wikidataQid, structuredClone(poi));
    }
  }

  async getPois(citySlug: string): Promise<Poi[]> {
    const byQid = this.pois.get(citySlug);
    return byQid ? structuredClone([...byQid.values()]) : [];
  }

  async spendTodayUsd(): Promise<number> {
    const now = new Date();
    let total = 0;
    for (const job of this.jobs.values()) {
      if (isSameUtcDay(job.createdAt, now)) {
        total += job.costUsd;
      }
    }
    // cost_usd is numeric(10,4) in Postgres — round the same way here so a
    // long run of in-memory tests can't accumulate binary floating-point
    // drift that the real database would never show.
    return Math.round(total * 10000) / 10000;
  }

  /**
   * Test-only escape hatch. The public interface has no way to backdate a
   * job (`updateJob` excludes `createdAt`), but `repository.test.ts` needs
   * one job from "yesterday" to prove `spendTodayUsd` actually excludes it,
   * not just that it can sum today's jobs. Mirrored on
   * `PostgresTourRepository` with the same name and signature.
   */
  async _setJobCreatedAtForTest(id: string, createdAt: Date): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`_setJobCreatedAtForTest: no job with id "${id}"`);
    }
    job.createdAt = createdAt;
  }
}
