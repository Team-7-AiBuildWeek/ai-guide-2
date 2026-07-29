# AI Guide

A mobile-first React PWA that generates and plays GPS-triggered audio walking
tours: describe what you're interested in and how much time you have, and a
generation pipeline (Wikidata/Wikipedia/OpenStreetMap discovery, LLM
curation, Mapbox routing, LLM narration) assembles a tour that narrates
itself out loud as you physically arrive at each stop — no app to hold up
and read, no turn-by-turn navigation to follow. Bratislava is the only city
currently configured (`apps/api/src/config/cities.ts`).

## Workspace layout

An npm workspace monorepo; run every `npm` command from the repo root.

```
apps/web       React PWA — trigger engine, map, player UI, generate flow
apps/api       Hono service — generation pipeline, job orchestration, Postgres persistence
packages/shared  Zod schemas and types shared by both apps
```

- `apps/web` is a pure client: a `TriggerEngine`
  (`apps/web/src/lib/trigger/engine.ts`) decides what should play from a
  stream of location fixes, driven by a swappable `LocationProvider` (real
  GPS or a simulator) and feeding a swappable `AudioPlayer` (speech
  synthesis or pre-recorded audio) — a future Capacitor native shell can
  supply true background GPS without a rewrite of this core logic.
- `apps/api` runs the generation pipeline behind `POST /api/tours` (kicks off
  a job), `GET /api/tours/:jobId/events` (SSE progress), and
  `GET /api/tours/:tourId` (the finished tour). It also serves `apps/web`'s
  built assets in production — one Fly app, one process. Every outbound
  network call it makes (Wikidata, Wikipedia, Overpass, Mapbox, Anthropic)
  goes through a cassette layer (`apps/api/src/cassette/`) that defaults to
  replaying committed fixtures rather than ever spending money by accident —
  see `docs/TESTING.md`.

## Prerequisites

- **Node `25.2.1`**, exactly — pinned in `.nvmrc`. Put it first on `PATH`
  before running any `npm` command; do **not** `nvm use` (rewrites a
  machine-wide symlink, not this repo's to change):
  ```powershell
  $env:PATH = "C:\Users\<you>\AppData\Local\nvm\v25.2.1;" + $env:PATH
  ```
  The `engines` field allows a wider range (`^20.19.0 || >=22.12.0`), but the
  test suite specifically cannot run on 20.17.0 — see `docs/TESTING.md` for
  why (`ERR_REQUIRE_ESM` inside jsdom's dependency chain; a green `npm run
  build` on that version proves nothing about whether tests pass).
- A [Mapbox](https://www.mapbox.com/) account and a public access token, for
  the map view and for the routing stage.
- To actually run generation against real data instead of replayed
  cassettes: a [Supabase](https://supabase.com) Postgres database and an
  [Anthropic](https://console.anthropic.com) API key. Neither is required to
  develop, test, or build — see `.env.example` and `docs/TESTING.md`'s
  cassette-modes section.

## Install

```bash
npm install
```

## Environment

Two separate templates, because Vite and the API load environment
differently:

- **`.env.local.example`** → copy to `.env.local` at the repo root. Vite
  auto-loads this for `apps/web`'s `VITE_MAPBOX_TOKEN`. Without a valid
  token the map degrades to a placeholder ("Map unavailable right now") —
  narration still plays.
  ```bash
  cp .env.local.example .env.local
  ```
- **`.env.example`** → the full variable set `apps/api` reads from the
  process environment (no auto-loading — export these yourself, see the
  file's header comment). Only needed to run `npm run dev:api` against real
  services instead of the in-memory repository and replayed cassettes.

Both files are gitignored once copied; never commit one with real values.

## Running it

```bash
npm run dev       # apps/web dev server (Vite)
npm run dev:api   # apps/api dev server (Hono, in-memory repo unless DATABASE_URL is set)
```

- **Real GPS**: open the printed URL and tap **Start the walk**. Requires a
  secure context (`https://` or `localhost`) — see `docs/TESTING.md` for
  testing over HTTPS on a phone.
- **Simulated walk** (no walking required): open the URL with `?sim=1`, e.g.
  `http://localhost:5173/?sim=1`. This replays a fixture tour's route as a
  stream of fixes and adds a **dev** panel (speed control up to a 10×
  ceiling, pause/resume, jump-to, inject-bad-fix) for exercising the trigger
  engine in seconds. See `docs/TESTING.md` for a full manual walkthrough.

## Tests and build

```bash
npm test          # vitest run, from the repo root (all workspaces)
npm run build     # tsc -b && vite build, per workspace
```

Both require the Node version above. `apps/api`'s Postgres-backed repository
tests skip unless `DATABASE_URL` is set in the shell (306 passed / 9 skipped
without it, 315 passed with it — see `docs/TESTING.md`). See
`docs/TESTING.md` for manual testing procedures the automated suite doesn't
cover, including the **live-run checklist** for the first real walk with
this app — narration audibility and the wake lock have not yet been
confirmed on real hardware.

## Deployment

See `docs/DEPLOYMENT.md`. It's written for the repo owner to run by hand —
it needs accounts (Supabase, Fly.io, Mapbox, Anthropic) an agent shouldn't be
creating or spending money against.

## What this does not do yet

- **Only one city.** Bratislava is the only configured city
  (`apps/api/src/config/cities.ts`); adding another means adding its
  `CityConfig`, not a code change to the pipeline itself.
- **No turn-by-turn navigation or rerouting.** The app tells you what's
  nearby, not how to get there.
- **The screen must stay on and the tab foregrounded.** Locking the screen
  or backgrounding the tab suspends GPS (a platform limit); the tour resumes
  when you return but won't have triggered anything while away. The fix for
  this is a native (Capacitor) shell, not a code change here.
- **Never run on a real phone.** See the live-run checklist in
  `docs/TESTING.md`.
