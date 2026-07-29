import type { GenerateRequest, Tour } from '@ai-guide/shared';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobStage = 'discovery' | 'curation' | 'routing' | 'narration';

/**
 * The shape sent down the wire on every SSE event — mirrors
 * `jobEventPayload` in `apps/api/src/routes/tours.ts` exactly. Duplicated
 * here rather than imported because `apps/web` does not depend on
 * `apps/api`; if the wire shape ever drifts, `tours.test.ts` on the API side
 * and this client's tests are the two places that would need updating.
 */
export interface JobEvent {
  status: JobStatus;
  stage: JobStage | null;
  tourId: string | null;
  error: string | null;
}

/**
 * Thrown by `createTour` on a 401. A user who mistyped the passphrase needs
 * to be told that specifically, not left staring at a generic failure — see
 * task 11 brief.
 */
export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase.');
    this.name = 'WrongPassphraseError';
  }
}

export interface ApiClient {
  createTour(req: GenerateRequest): Promise<{ jobId: string }>;
  /** Returns an unsubscribe function. Always call it — a leaked EventSource
   * on a phone is a battery cost the user pays silently. */
  subscribeToJob(jobId: string, onEvent: (job: JobEvent) => void): () => void;
  getTour(tourId: string): Promise<Tour>;
}

const PASSPHRASE_KEY = 'ai-guide:passphrase';

// `window.localStorage` rather than the bare global: Node 22+ ships its own
// global `localStorage` accessor (gated behind `--localstorage-file`, which
// this repo does not set), and on this machine it shadows the real one with
// a broken stub missing `clear()`. `window.localStorage` is unambiguous in
// both the browser and jsdom test environment.
export function getStoredPassphrase(): string | null {
  return window.localStorage.getItem(PASSPHRASE_KEY);
}

export function setStoredPassphrase(value: string): void {
  window.localStorage.setItem(PASSPHRASE_KEY, value);
}

/** Called after a 401 so the next attempt re-prompts instead of silently
 * retrying the same wrong value forever. */
export function clearStoredPassphrase(): void {
  window.localStorage.removeItem(PASSPHRASE_KEY);
}

export interface CreateApiClientArgs {
  /** Defaults to same-origin (`''`), which is what a single Fly app serving
   * both the API and the static build will be. */
  baseUrl?: string;
  fetch?: typeof fetch;
  getPassphrase?: () => string | null;
  /** Injectable for tests; defaults to the global `EventSource`. */
  EventSourceImpl?: typeof EventSource;
}

export function createApiClient(args: CreateApiClientArgs = {}): ApiClient {
  const baseUrl = args.baseUrl ?? (import.meta.env.VITE_API_BASE_URL || '');
  const doFetch = args.fetch ?? fetch;
  const getPassphrase = args.getPassphrase ?? getStoredPassphrase;

  function authHeader(): Record<string, string> {
    const passphrase = getPassphrase();
    return passphrase !== null ? { authorization: `Bearer ${passphrase}` } : {};
  }

  return {
    async createTour(req) {
      const res = await doFetch(`${baseUrl}/api/tours`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(req),
      });

      if (res.status === 401) throw new WrongPassphraseError();
      if (!res.ok) {
        throw new Error(`Could not start generation (status ${res.status}).`);
      }
      return (await res.json()) as { jobId: string };
    },

    subscribeToJob(jobId, onEvent) {
      const EventSourceCtor = args.EventSourceImpl ?? EventSource;
      const source = new EventSourceCtor(`${baseUrl}/api/tours/${jobId}/events`);
      source.onmessage = (event) => {
        onEvent(JSON.parse(event.data) as JobEvent);
      };
      return () => source.close();
    },

    async getTour(tourId) {
      const res = await doFetch(`${baseUrl}/api/tours/${tourId}`);
      if (!res.ok) {
        throw new Error(`Could not load the finished tour (status ${res.status}).`);
      }
      return (await res.json()) as Tour;
    },
  };
}
