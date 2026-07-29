import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerateRequest, Tour } from '@ai-guide/shared';
import {
  createApiClient,
  WrongPassphraseError,
  getStoredPassphrase,
  setStoredPassphrase,
  clearStoredPassphrase,
} from './client';

function makeRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    city: 'Bratislava',
    profileText: 'brutalist architecture',
    language: 'en',
    persona: '',
    budgetMin: 60,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient', () => {
  beforeEach(() => window.localStorage.clear());

  describe('createTour', () => {
    it('POSTs the request with the passphrase as a Bearer token', async () => {
      const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ jobId: 'job-1' }, 202));
      const client = createApiClient({
        baseUrl: '',
        fetch: fetchStub as unknown as typeof fetch,
        getPassphrase: () => 'sesame',
      });

      const result = await client.createTour(makeRequest());

      expect(result).toEqual({ jobId: 'job-1' });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      const [url, init] = fetchStub.mock.calls[0];
      expect(url).toBe('/api/tours');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sesame');
      expect(JSON.parse(init.body as string)).toEqual(makeRequest());
    });

    it('omits the Authorization header when no passphrase is stored', async () => {
      const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ jobId: 'job-1' }, 202));
      const client = createApiClient({
        baseUrl: '',
        fetch: fetchStub as unknown as typeof fetch,
        getPassphrase: () => null,
      });

      await client.createTour(makeRequest());

      const init = fetchStub.mock.calls[0][1];
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
    });

    it('surfaces a 401 as WrongPassphraseError, not a generic failure', async () => {
      const fetchStub = vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401));
      const client = createApiClient({ baseUrl: '', fetch: fetchStub, getPassphrase: () => 'wrong' });

      await expect(client.createTour(makeRequest())).rejects.toBeInstanceOf(WrongPassphraseError);
    });

    it('throws a plain Error for a non-401 failure', async () => {
      const fetchStub = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
      const client = createApiClient({ baseUrl: '', fetch: fetchStub, getPassphrase: () => 'sesame' });

      await expect(client.createTour(makeRequest())).rejects.toThrow(/500/);
    });
  });

  describe('subscribeToJob', () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      url: string;
      onmessage: ((event: { data: string }) => void) | null = null;
      closed = false;
      constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
      }
      close() {
        this.closed = true;
      }
      emit(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) });
      }
    }

    beforeEach(() => {
      FakeEventSource.instances = [];
    });

    it('opens an EventSource at the job events URL and forwards parsed events', () => {
      const client = createApiClient({
        baseUrl: '',
        EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      });
      const received: unknown[] = [];

      client.subscribeToJob('job-1', (event) => received.push(event));

      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0].url).toBe('/api/tours/job-1/events');

      FakeEventSource.instances[0].emit({ status: 'running', stage: 'discovery', tourId: null, error: null });
      expect(received).toEqual([{ status: 'running', stage: 'discovery', tourId: null, error: null }]);
    });

    it('closes the EventSource when the returned unsubscribe is called', () => {
      const client = createApiClient({
        baseUrl: '',
        EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      });

      const unsubscribe = client.subscribeToJob('job-1', () => {});
      expect(FakeEventSource.instances[0].closed).toBe(false);

      unsubscribe();
      expect(FakeEventSource.instances[0].closed).toBe(true);
    });
  });

  describe('getTour', () => {
    it('GETs the tour by id', async () => {
      const tour = { id: 'tour-1' } as Tour;
      const fetchStub = vi.fn(async () => jsonResponse(tour, 200));
      const client = createApiClient({ baseUrl: '', fetch: fetchStub });

      const result = await client.getTour('tour-1');

      expect(fetchStub).toHaveBeenCalledWith('/api/tours/tour-1');
      expect(result).toEqual(tour);
    });

    it('throws when the tour is not found', async () => {
      const fetchStub = vi.fn(async () => jsonResponse({ error: 'Tour not found.' }, 404));
      const client = createApiClient({ baseUrl: '', fetch: fetchStub });

      await expect(client.getTour('missing')).rejects.toThrow(/404/);
    });
  });
});

describe('passphrase storage', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips through localStorage and clears on demand', () => {
    expect(getStoredPassphrase()).toBeNull();
    setStoredPassphrase('sesame');
    expect(getStoredPassphrase()).toBe('sesame');
    clearStoredPassphrase();
    expect(getStoredPassphrase()).toBeNull();
  });
});
