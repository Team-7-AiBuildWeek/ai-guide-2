import type { GenerateRequest, Poi, Tour } from '@ai-guide/shared';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobStage = 'discovery' | 'curation' | 'routing' | 'narration';

/**
 * The durable row that lets a phone reconnect to a generation in progress.
 * One row per `/generate` request; `stage`/`stageOutput` let the orchestrator
 * (task 10) resume from wherever it left off, and `costUsd` is what
 * `spendTodayUsd` sums to enforce the daily spend cap.
 */
export interface Job {
  id: string;
  cityId: string;
  status: JobStatus;
  stage: JobStage | null;
  request: GenerateRequest;
  stageOutput: Record<string, unknown>;
  tourId: string | null;
  error: string | null;
  costUsd: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Persistence for the generation pipeline: discovered POIs, generated tours
 * and their segments, and the job row.
 *
 * There are two implementations of this interface — `InMemoryTourRepository`
 * (tests) and `PostgresTourRepository` (the real Supabase database) — and
 * exactly one contract suite in `repository.test.ts` that runs against both.
 * That is the structural guarantee that the in-memory implementation cannot
 * silently drift from what the real one actually does.
 */
export interface TourRepository {
  createJob(cityId: string, request: GenerateRequest): Promise<Job>;
  getJob(id: string): Promise<Job | null>;
  updateJob(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Promise<Job>;
  saveTour(tour: Tour): Promise<void>;
  getTour(id: string): Promise<Tour | null>;
  savePois(citySlug: string, pois: Poi[]): Promise<void>;
  getPois(citySlug: string): Promise<Poi[]>;
  spendTodayUsd(): Promise<number>;
}
