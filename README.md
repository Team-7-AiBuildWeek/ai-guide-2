# Tour Player

A mobile-first React PWA that plays GPS-triggered audio walking tours. It
watches your location, and speaks narration written for a given city
automatically as you arrive at each stop — client-side only, no backend.

Architecture: a pure `TriggerEngine` (`src/lib/trigger/engine.ts`) decides
what should play from a stream of location fixes. It's driven by a swappable
`LocationProvider` (real GPS or a simulator) and feeds a swappable
`AudioPlayer` (speech synthesis or pre-recorded audio), so a future Capacitor
native shell can supply true background GPS without a rewrite of the core
logic.

## Prerequisites

- **Node `^20.19.0 || >=22.12.0`** (see `engines` in `package.json`). This
  repo is built and tested against the exact version pinned in `.nvmrc`
  (`25.2.1`) — put it first on `PATH` before running any `npm` command:
  ```bash
  export PATH="/path/to/nvm/versions/node/v25.2.1/bin:$PATH"
  ```
  The machine's system-default Node may be older and can run `npm run
  build` successfully while `npm test` dies with `ERR_REQUIRE_ESM` inside
  jsdom's dependency chain — a green build is not evidence the tests pass.
  See `docs/TESTING.md` for the full explanation.
- A [Mapbox](https://www.mapbox.com/) account and a public access token, for
  the map view.

## Install

```bash
npm install
```

## Mapbox token

Copy `.env.local.example` to `.env.local` and fill in your token:

```bash
cp .env.local.example .env.local
```

```
VITE_MAPBOX_TOKEN=pk.your_public_token_here
```

`.env.local` is gitignored. Without a valid token the map degrades to a
placeholder ("Map unavailable right now") — narration still plays.

## Running it

```bash
npm run dev
```

- **Real GPS**: open the printed URL and tap **Start the walk**. Requires a
  secure context (`https://` or `localhost`) — see `docs/TESTING.md` for
  testing over HTTPS on a phone.
- **Simulated walk** (no walking required): open the URL with `?sim=1`, e.g.
  `http://localhost:5173/?sim=1`. This replays the tour's route as a stream
  of fixes and adds a **dev** panel (speed control, pause/resume, jump-to,
  inject-bad-fix) for exercising the trigger engine in seconds. See
  `docs/TESTING.md` for a full manual walkthrough of both modes.

## Tests and build

```bash
npm test          # vitest run
npm run build     # tsc -b && vite build
```

Both require the Node version above. See `docs/TESTING.md` for manual
testing procedures the automated suite doesn't cover (permission
denial/recovery, real GPS on a phone, StrictMode double-invoke checks).

## What this does not do yet

- **No generation pipeline.** Tour content (`src/fixtures/amsterdam-tour.ts`)
  is hand-authored placeholder narration for exercising the player; building
  tours from real source material is a later plan.
- **No turn-by-turn navigation or rerouting.** The app tells you what's
  nearby, not how to get there.
- **The screen must stay on and the tab foregrounded.** Locking the screen
  or backgrounding the tab suspends GPS (a platform limit); the tour resumes
  when you return but won't have triggered anything while away. The fix for
  this is a native (Capacitor) shell, not a code change here.
