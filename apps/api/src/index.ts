import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { InMemoryTourRepository } from './db/memory.ts';
import { PostgresTourRepository } from './db/postgres.ts';
import type { TourRepository } from './db/repository.ts';
import { AnthropicLlmClient } from './llm/anthropic.ts';
import { FileCassetteStore, cassetteFetch, resolveCassetteMode } from './cassette/index.ts';
import { resolveMapboxToken } from './stages/routing/mapbox.ts';
import { createGenerateAuthMiddleware } from './auth.ts';
import { createToursRouter } from './routes/tours.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', 'cassettes');

/** Postgres when `DATABASE_URL` is set (production, or a developer pointed
 * at a real Supabase instance), the in-memory repository otherwise — so
 * `npm run dev:api` works out of the box without a database. */
function buildRepository(): TourRepository {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl ? new PostgresTourRepository(databaseUrl) : new InMemoryTourRepository();
}

const repo = buildRepository();

// Every outbound HTTP call this process makes — Wikidata/Wikipedia/Overpass
// AND the Anthropic SDK's own fetch — goes through the same cassette
// wrapper, so `CASSETTE_MODE=replay` (the default) never spends money by
// accident in development. Mapbox gets its own token-redacting variant
// because its URL carries a credential the cassette key must never see (see
// stages/routing/mapbox.ts); Anthropic and the discovery/narration fetches
// carry no such token and share this one.
const cassetteMode = resolveCassetteMode();
const cassetteStore = new FileCassetteStore(cassetteDir);
const wrappedFetch = cassetteFetch(cassetteMode, cassetteStore, fetch);

const llm = new AnthropicLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', fetch: wrappedFetch });
const mapboxToken = resolveMapboxToken();

// Throws if GENERATE_PASSPHRASE is unset — see auth.ts. This module must not
// import cleanly into a process that would otherwise serve every request.
const auth = createGenerateAuthMiddleware({ repo });

const toursRouter = createToursRouter({
  repo,
  llm,
  fetch: wrappedFetch,
  mapboxToken,
  auth,
});

export const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/', toursRouter);
