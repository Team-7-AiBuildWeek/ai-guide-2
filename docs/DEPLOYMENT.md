# Deployment

This is written for the repo owner to run by hand — every step needs an
account (Supabase, Fly.io, Mapbox, Anthropic) that isn't the assistant's to
create or spend money against. Nothing in this document should be run by an
agent; `fly deploy` in particular spends real money and touches your Fly
account.

## 0. What you'll need

- A [Supabase](https://supabase.com) account (Postgres + PostGIS, free tier is fine to start)
- A [Fly.io](https://fly.io) account with `flyctl` installed and `fly auth login` run
- A [Mapbox](https://www.mapbox.com) account and a **public** (`pk.`) access token
- An [Anthropic](https://console.anthropic.com) account and API key — only needed if you intend to run real (non-cassette) generation

## 1. Database: Supabase

1. Create a new Supabase project.
2. Get the connection string: **Project Settings → Database → Connection
   string**, and use the **Connection pooling** tab, **Session mode** (port
   5432) — not the direct connection string shown on the main tab.

   **Why this matters and isn't optional:** the direct-connection host
   (`db.<ref>.supabase.co`) is IPv6-only. A machine or network without IPv6
   cannot reach it at all — not a clear error, just a hang or a refused
   connection with nothing in the message that says "IPv6". The session
   pooler host resolves over IPv4 as well and is otherwise a drop-in
   replacement. This is recorded again on `DATABASE_URL` in `.env.example`
   because it already cost real debugging time once.
3. Apply the schema. It lives at `apps/api/src/db/schema.sql` (PostGIS
   extension plus the `cities`, `pois`, `tours`, `segments` and `jobs`
   tables) and every statement is idempotent (`if not exists` / guarded), so
   re-running it is safe. Use the provided script rather than hand-running
   SQL — put the pooler connection string above in `.env.local` (or the
   shell environment) as `DATABASE_URL` first:
   ```powershell
   $env:PATH = "C:\Users\<you>\AppData\Local\nvm\v25.2.1;" + $env:PATH
   node --experimental-strip-types apps/api/scripts/apply-schema.ts
   ```
   (`apps/api/scripts/apply-schema.ts` never prints the connection string,
   including on failure. The Supabase SQL editor works too if you'd rather
   paste the file in by hand.)

## 2. Fly app

`fly.toml` is already committed (app `ai-guide-2`, region `iad`, one shared
1 GB VM, `internal_port = 8080`). If you want a fresh app instead of reusing
that one, run `fly apps create <new-name>` and change `app = '...'` in
`fly.toml` to match before deploying.

### Deploying by pushing (no `flyctl` needed)

If Fly's GitHub App is connected to this repo, a push to `main` builds and
deploys on its own. That path cannot receive `--build-arg` from a command
line, which is why `fly.toml` carries a `[build.args]` block with
`VITE_MAPBOX_TOKEN` in it. **Replace the `pk.REPLACE_ME` placeholder there
before your first push**, or the deploy succeeds and the map is dead.

Putting a Mapbox token in a committed file is deliberate, not sloppy: `pk.`
tokens are public by design and already ship inside the client JS of every
build, so this exposes nothing a visitor could not read from the bundle.
Restrict it to your `.fly.dev` hostname in the Mapbox dashboard
(Account → Tokens → URL restrictions) and it is safe to commit.

Runtime secrets still have to be set once, from the Fly dashboard
(Secrets tab) or the CLI. The dashboard is enough — no `flyctl` install
required.

### A first deploy that cannot spend money

Recommended for the first one, and for the first real walk:

| Variable | Set it to | Why |
|---|---|---|
| `GENERATE_PASSPHRASE` | a long random string | The app refuses to start without it |
| `DATABASE_URL` | the session-pooler URI | Jobs and tours |
| `VITE_MAPBOX_TOKEN` | your `pk.` token | Routing reads it server-side; without it the container will not boot |
| `ANTHROPIC_API_KEY` | **do not set it** | See below |
| `LLM_MODE` | leave unset | Defaults to synthetic — serves the recorded fixtures |
| `CASSETTE_MODE` | leave unset | Defaults to `replay` — never calls a paid API |

Leaving `ANTHROPIC_API_KEY` unset is a safety property, not an oversight: if
`LLM_MODE=live` were ever set by accident, the app **refuses to start** rather
than billing you. Add the key only when you deliberately want to pay for a
live generation.

A deploy configured this way runs the whole pipeline — discovery, curation,
routing, narration, the map, the player — from the 106 committed cassettes,
at zero cost. It proves everything that has never been tested (Fly's build,
HTTPS, cold start, Supabase reachable from Fly's network, and the app running
on a real phone) without spending a cent.

### Runtime secrets

These are read by the Node process at request time, so `fly secrets set` is
the right mechanism for all of them:

```bash
fly secrets set ANTHROPIC_API_KEY="sk-ant-..."
fly secrets set DATABASE_URL="postgresql://...pooler..."
fly secrets set GENERATE_PASSPHRASE="$(openssl rand -hex 32)"
fly secrets set DAILY_SPEND_CAP_USD=5
fly secrets set CASSETTE_MODE=live
fly secrets set VITE_MAPBOX_TOKEN="pk.your_real_token"
```

That last one is not a typo — see below. `VITE_MAPBOX_TOKEN` needs to be set
**both** as a runtime secret and as a build argument; skipping either one
breaks a different part of the app.

`CASSETTE_MODE` deserves a deliberate choice, not the default:
- `replay` (the default in `.env.example`) never calls a paid API — it only
  replays the committed synthetic cassettes under `apps/api/cassettes/`,
  which cover Bratislava. Safe, but a deployed app running in `replay` mode
  cannot generate a tour for anything the cassettes don't already contain.
- `live` makes real calls to Wikidata/Wikipedia/Overpass, Mapbox and
  Anthropic, and spends real money on every generation (gated by
  `GENERATE_PASSPHRASE` and `DAILY_SPEND_CAP_USD`). This is what you want
  running once you're ready to generate a tour for real.

### `VITE_MAPBOX_TOKEN` needs setting twice — verified, not theoretical

This was confirmed by actually building the image and running it locally
with `docker run`, not just read off the source:

1. **Build time.** Vite inlines `VITE_`-prefixed variables into the static JS
   bundle. `fly secrets set` only ever reaches the already-built,
   already-running container — it cannot change what got baked into
   `apps/web/dist` during `docker build`. Supply it as a build argument:
   ```bash
   fly deploy --build-arg VITE_MAPBOX_TOKEN="pk.your_real_token"
   ```
2. **Runtime, too.** `apps/api/src/stages/routing/mapbox.ts`'s
   `resolveMapboxToken()` reads this same variable (or `MAPBOX_TOKEN`) to
   call Mapbox Directions server-side for the routing stage — checked at
   process startup, not lazily, so **the container will not boot at all**
   without it. Running the built image locally with only
   `GENERATE_PASSPHRASE` and `CASSETTE_MODE=replay` set crashed immediately
   with `Error: MAPBOX_TOKEN (or VITE_MAPBOX_TOKEN) is not set in the
   environment` — adding `VITE_MAPBOX_TOKEN` as a plain runtime env var
   fixed it. So the `fly secrets set VITE_MAPBOX_TOKEN=...` line above is
   required, not optional, alongside the build argument.

(This is Mapbox's *public* token, meant to be shipped inside client bundles
and restricted by URL on Mapbox's side — baking it into image layer history
via a build arg is not the secret leak that baking `ANTHROPIC_API_KEY` in the
same way would be. Don't do that with any of the other variables.)

If you switch to Fly's GitHub-integration deploys (below), there is no
`--build-arg` flag to pass — add a `[build.args]` table to `fly.toml` instead
(safe to commit, since this value is meant to be public):
```toml
[build.args]
  VITE_MAPBOX_TOKEN = "pk.your_real_token"
```

## 3. Deploy

```bash
fly deploy --build-arg VITE_MAPBOX_TOKEN="pk.your_real_token"
```

**`fly deploy` run from a laptop uses the current local directory as the
Docker build context.** That is exactly why `.dockerignore` matters: anything
not excluded there is available to the build (`.git`, `node_modules`,
`.env.local`, `docs/`, `.superpowers/`, ...). `.dockerignore` at the repo root
already excludes all of those — see its header comment for the history of
why (a static-file Dockerfile once generated by Fly Launch would have
published `.env.local` and `.git` as downloadable files). If you ever edit
`.dockerignore`, keep the secrets/`.git`/`node_modules`/build-output
exclusions intact.

Fly's **GitHub-integration** deploys (auto-deploy on push, configured from
the Fly dashboard) build from the **committed repository** instead of your
local directory — an uncommitted local change (including an uncommitted fix)
cannot ship through that path, but equally a local secret sitting in your
working tree that never got committed cannot leak through it either. Either
deploy path is fine; know which one you're using.

### What's actually been verified about the container, and what hasn't

`docker build` and `docker run` were both exercised locally against this
exact Dockerfile (Docker Desktop's daemon was not running earlier in this
project — it was started to check this): the image builds, the container
boots, `apps/api/src/server.ts`'s explicit `0.0.0.0` bind was confirmed in
its own startup log line, and both `GET /api/health` (`{"ok":true}`) and
`GET /` (the built web app, `200`) were confirmed against the running
container on a mapped local port. One real build bug was caught and fixed
this way (see the Dockerfile's `npm install -g npm@11.6.2` line and its
comment — the base image's bundled npm considered the committed lock file
out of sync and refused `npm ci` outright) and one real runtime bug (the
missing-`VITE_MAPBOX_TOKEN`-at-runtime crash above).

**Not verified:** an actual `fly deploy` — that step was deliberately never
run, since it spends the account owner's money and touches their Fly
account. Cold start behavior, Fly's health checks, TLS termination, and
behavior under Fly's actual networking (vs. Docker Desktop's local NAT) are
all consequently unverified by anything in this document. The first real
`fly deploy` you run is the first real test of that part.

## 4. Verify

1. **Health check:**
   ```bash
   curl https://<your-app>.fly.dev/api/health
   # {"ok":true}
   ```
   The **first** request after any idle period pays a cold start (machine
   boot + Node startup, several seconds) — `fly.toml`'s
   `min_machines_running = 0` trades that delay for near-zero idle cost.
   Expect it; it is not a bug.

2. **A real generation**, once `CASSETTE_MODE=live` and all secrets are set:
   ```bash
   curl -i -X POST https://<your-app>.fly.dev/api/tours \
     -H "Authorization: Bearer <your GENERATE_PASSPHRASE>" \
     -H "Content-Type: application/json" \
     -d '{"city":"bratislava","profileText":"medieval history and coffee","language":"en","persona":"a curious local friend","budgetMin":60}'
   ```
   This returns `202` with `{"jobId": "..."}`. Watch it finish either by
   opening the deployed web app itself and using the Generate screen (the
   simplest check — it drives the same SSE endpoint), or:
   ```bash
   curl -N https://<your-app>.fly.dev/api/tours/<jobId>/events
   ```
   which streams one JSON line per stage transition
   (discovery → curation → routing → narration → done).

   A wrong passphrase returns `401`; exceeding `DAILY_SPEND_CAP_USD` returns
   `429` with the amount already spent today in the message. Both are
   working as intended, not errors to debug.

## 5. What this document does not, and cannot, verify

Everything above confirms the service answers HTTP requests and can run a
real generation. None of it confirms the experience the app exists for:
narration audible from a phone speaker outdoors, the screen staying awake
mid-walk, GPS triggering reliably while moving. See the **live-run
checklist** in `docs/TESTING.md` for what is still genuinely unverified —
read it before the first real walk, not during it.
