// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { GenerateRequest } from '@ai-guide/shared';
import { InMemoryTourRepository } from './db/memory.ts';
import { createGenerateAuthMiddleware } from './auth.ts';

function makeRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    city: 'Bratislava',
    profileText: 'brutalist architecture',
    language: 'en',
    persona: 'a grumpy local historian',
    budgetMin: 90,
    ...overrides,
  };
}

function buildApp(repo: InMemoryTourRepository, env: NodeJS.ProcessEnv) {
  const app = new Hono();
  const mw = createGenerateAuthMiddleware({ repo, env });
  app.post('/api/tours', mw, (c) => c.json({ ok: true }));
  return app;
}

describe('createGenerateAuthMiddleware', () => {
  it('throws when constructing without GENERATE_PASSPHRASE set — refuses to start rather than default open', () => {
    const repo = new InMemoryTourRepository();
    expect(() => createGenerateAuthMiddleware({ repo, env: {} })).toThrow();
  });

  it('rejects a request with no Authorization header', async () => {
    const repo = new InMemoryTourRepository();
    const app = buildApp(repo, { GENERATE_PASSPHRASE: 'sesame' });

    const res = await app.request('/api/tours', { method: 'POST', body: '{}' });

    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong passphrase', async () => {
    const repo = new InMemoryTourRepository();
    const app = buildApp(repo, { GENERATE_PASSPHRASE: 'sesame' });

    const res = await app.request('/api/tours', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer wrong-word' },
    });

    expect(res.status).toBe(401);
  });

  it('passes through with the correct passphrase, under the cap', async () => {
    const repo = new InMemoryTourRepository();
    const app = buildApp(repo, { GENERATE_PASSPHRASE: 'sesame', DAILY_SPEND_CAP_USD: '5' });

    const res = await app.request('/api/tours', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer sesame' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 429 once today\'s spend is at the cap', async () => {
    const repo = new InMemoryTourRepository();
    const job = await repo.createJob('bratislava', makeRequest());
    await repo.updateJob(job.id, { costUsd: 5 });
    const app = buildApp(repo, { GENERATE_PASSPHRASE: 'sesame', DAILY_SPEND_CAP_USD: '5' });

    const res = await app.request('/api/tours', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer sesame' },
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('5');
  });

  it('passes through when spend is under the cap', async () => {
    const repo = new InMemoryTourRepository();
    const job = await repo.createJob('bratislava', makeRequest());
    await repo.updateJob(job.id, { costUsd: 1 });
    const app = buildApp(repo, { GENERATE_PASSPHRASE: 'sesame', DAILY_SPEND_CAP_USD: '5' });

    const res = await app.request('/api/tours', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer sesame' },
    });

    expect(res.status).toBe(200);
  });

  it('defaults the cap to $5 when DAILY_SPEND_CAP_USD is unset', async () => {
    const repo = new InMemoryTourRepository();
    const job = await repo.createJob('bratislava', makeRequest());
    await repo.updateJob(job.id, { costUsd: 5 });
    const app = buildApp(repo, { GENERATE_PASSPHRASE: 'sesame' });

    const res = await app.request('/api/tours', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer sesame' },
    });

    expect(res.status).toBe(429);
  });
});
