# Plan 2a — Outcome and Carry-Forward

**Date:** 2026-07-29
**Status:** All 12 tasks complete. 315 tests passing, `npm run build` exit 0,
everything pushed to `origin/main`.

Plan 2a built the generation pipeline: a Hono service that turns free text
into a walkable, AI-narrated tour of Bratislava's old town, backed by
Supabase, with every external call behind a record/replay layer so
development costs nothing.

This document records what a later plan needs to know, because the scratch
execution workspace is deleted once the work lands.

## Verified working

- **All four pipeline stages**, end to end in replay: discovery → curation →
  routing → narration → `assembleTour`.
- **The assembled Tour drives the real `TriggerEngine`**, firing all fifteen
  triggerable segments in ascending tour order along the real recorded
  Mapbox route. This is the only test that proves what we generate is
  actually playable, and it is worth more than the rest combined.
- **The Postgres repository against the owner's real Supabase database** —
  all nine contract assertions, including coordinate round-tripping to six
  decimal places and numeric cost summation.
- **The Docker image builds and boots**: container bound to `0.0.0.0`,
  `/api/health` → 200, `/` → 200.
- **150 real Bratislava POIs** from Wikidata/Wikipedia/OSM, ranked by
  notability, with the landmarks a guidebook would pick at the top.

## L1 — done. What first contact with Opus 5 cost and taught

**Total spend: $2.57** ($2.21 on L1, $0.36 verifying the budget fix) against a
$0.46 estimate. The gap is entirely thinking tokens, which bill as output and
were not counted.

**Measured cost of a cold tour, one language: ~$0.79** — curation $0.35 plus
narration $0.44. Before the distance-budget fix it would have been ~$1.14,
because the over-budget re-curation fired on any realistic request. The spec's
$0.46 should be replaced with $0.79.

| | |
|---|---|
| 2 curation attempts, truncated | $0.40 wasted |
| Curation, succeeded (157s) | $0.32 |
| 2 narration attempts, rejected on a 9-character overrun | $0.88 wasted |
| Narration, succeeded (345s) | $0.44 |

Three of my own design errors, none findable without paying:

1. **`max_tokens = 8000` was unachievable.** It caps thinking AND output
   together; adaptive thinking took 7182 of it, leaving 818 for JSON that
   needed ~1500. Raised to 32000. `max_tokens` is a ceiling, not a
   reservation — headroom is free.
2. **Per-segment length bounds were the wrong control.** 400–1400 characters
   rejected two paid responses over **nine characters**, and every one of the
   ten real stop scripts exceeded 1400 — the bound was unachievable while
   saying anything substantive. Bounds widened to catch only broken segments;
   the real check is now total narration duration against the budget.
3. **Curation cannot reason about a time budget.** Given "60 minutes" and
   coordinates, it produced a 5.2 km, 78-minute walk — 31% over. It was never
   told walking speed or dwell time, so the conversion was not available to
   it. It now receives an explicit distance budget in metres, derived from
   routing's own dwell constants.

   **Verified live, $0.36.** Same profile, same 60-minute request:

   | | baseline | with distance budget |
   |---|---|---|
   | walking distance | 5165 m | **3411 m** |
   | walking time | 61.7 min | **40.8 min** |
   | estimated total | 78.4 min | **59.2 min** |
   | `overBudget` | true | **false** |

   Within 1.3% of the request, and it chose *eleven* stops rather than ten —
   more places, shorter walk, which is the right trade. The model was never
   careless; it was uninformed.

   This also removes the re-curation that would otherwise fire on nearly every
   realistic request, so a cold 60-minute tour costs one curation instead of
   two.

**What the model did well**, and better than the hand-authored fixture:
grouped 12 QIDs into one Hlavné námestie stop; kept every pair ≥117 m apart;
honoured "I've already seen the castle" by omitting the single most notable
POI in the set, and again in the prose (*"Hrad necháme na pokoji"*).

**Latency is 3–6 minutes per stage, not "about a minute".** The durable-job
architecture is load-bearing, not merely prudent. Any UI copy promising a
minute is wrong.

## Walk cues are events, not places

Resolved, after four attempts, and only the fourth addressed the cause.

The first three treated it as geometry: break ties on tour order rather than
distance; make a cue wait for the stop it departs from; project stop
positions monotonically. Each was a real improvement. None closed it, because
each still assumed a cue is a **place**.

On the real 5.2 km route — which crosses itself twice, passing within a metre
of its own earlier path — a cue's 25%-along point can sit nearer a later part
of the walk than its own leg. Proximity was standing in for progress, and on
a self-intersecting route it is not one.

**A walk cue belongs to the moment you leave a stop.** The engine observes
that directly: the walker was inside the stop's radius, and now is not. Cues
are no longer proximity candidates at all, which deletes the cue radius, the
projection question, and the entire failure class. Departure fires on the
first qualifying fix — no hysteresis, because leaving is an event rather than
a place you dwell in — and the radius is accuracy-widened exactly as the
stop's own is, so a noisy fix cannot bounce a walker out of a stop they are
standing in.

A skipped stop never arms its cue, which is correct: that leg was not walked.

The end-to-end ordering test found three separate real defects before it
found this one, and was kept strict throughout rather than loosened to
something that would pass.

## Plan 2b progress — voice

**The toponym spike passed.** Chirp 3 HD reads Slovak street names in German,
Spanish and Italian voices well enough to find the place from. That settles
the vendor and closes parent-spec §11.1 and §11.2. Cost: $0.03, inside the
free tier.

**The golden tour is voiced.** 21 segments, 20,320 characters, 61 seconds,
$0. Synthesis is wired in as a fifth pipeline stage and a generated tour now
comes back with audio on every segment.

**Content addressing works across tours, verified.** A second generation of
the same tour produced the identical first `audio_url` hash — it re-used every
segment and billed nothing. That is the mechanism the whole cost model rests
on, and it is no longer theoretical.

Deliberate choices worth keeping:

- **Audio is keyed on text + language + voice, never on the audio bytes.**
  Chirp is non-deterministic — measured returning 4736, 4736 and then 3712
  bytes for identical input. Hashing output would defeat the cache and
  silently re-bill every render.
- **Synthesis failure is not fatal.** It runs inside the narration stage's
  try/catch and logs rather than failing the job: a tour with no audio still
  works via on-device speech, and throwing away a generation that cost real
  money and several minutes because Chirp was rate-limited is the worse
  outcome.
- **The player chooses per tour**, not globally — a tour generated before the
  voice pipeline existed still plays, robotically. Silence is the worse
  failure in an audio-first app.
- **The bucket is public**, which turned out to dissolve a Plan 1 worry: the
  service worker's `/\.mp3$/` rule *does* match real Supabase URLs, because
  public ones carry no query string.

### Open: offline audio is not actually being cached

The `.mp3` rule matches and a service worker is registered, but no
`tour-audio` cache exists after playback and nothing is stored in it.

Symptom verified; cause not. The likely explanation is that `<audio>` playback
issues Range requests, which Workbox's `CacheFirst` does not handle without
`RangeRequestsPlugin` — but that is a hypothesis. Fixing it probably means
either adding that plugin or pre-fetching each MP3 with `fetch()` so the
service worker sees an ordinary request it can cache.

This matters for the product: a tour that needs mobile data at every stop is
a different thing from one you download and walk.

## Not done — do not assume otherwise
- **`fly deploy` has never been run.** Fly's networking, TLS and cold-start
  behaviour are untested.
- **Still never run on a real phone.** Narration has never been confirmed
  audible on a device; the wake lock has never been exercised on hardware.
  This was Plan 1's outstanding item and it remains Plan 2a's.

## What the end-to-end test found

Every stage passed its own tests while the assembled tour played its final
stop three-quarters of the way through the walk. Three defects, all design
errors rather than implementation mistakes, none visible to any per-stage
test:

1. **Curation checked separation between consecutive stops only.** The
   trigger engine has no notion of consecutiveness — a radius catches a
   walker wherever they are. Two stops 62 m apart but four apart in tour
   order collided. Now every pair is checked.
2. **Ties between ready segments broke on distance.** Right for genuinely
   co-located stops, wrong everywhere else: on a route that doubles back —
   and Mapbox's real directions here do, passing within 0.1 m of an earlier
   point — distance says nothing about progress. Now breaks on tour order.
3. **A walk cue could fire before its own stop.** Structural, not geometric.
   Cues now wait for the stop they depart from.

The lesson generalises: **per-stage tests cannot see defects that live
between stages.** Budget for one integration test that drives real output
through real consumers, early.

## Conventions later plans must honour

- **Every pair of stops ≥100 m apart**, not just consecutive ones.
- **Trigger radii are rounded to 0.1 m.** Postgres `double precision` does
  not round-trip fifteen significant figures, and GPS accuracy makes them
  meaningless anyway.
- **`apps/api` relative imports carry explicit `.ts` extensions**;
  `apps/web` does not. Do not unify them — `apps/api` runs its TypeScript
  directly under Node type stripping with `noEmit`.
- **Cassette misses throw.** Never add a fallback to a live call.
- **The player is not to be modified** to accommodate generation. It
  consumes a `Tour`; provenance is not its concern. That seam held through
  this entire plan — `useTourPlayer.ts` and `engine.ts` have zero diffs from
  Task 11.

## Environment facts that cost real time

- **Supabase's direct connection host is IPv6-only.** A machine without IPv6
  cannot reach it. Use the **Session-mode pooler on port 5432** — IPv4, and
  unlike the transaction pooler on 6543 it supports prepared statements.
- **The suite cannot run on Node 20.17.0** (`ERR_REQUIRE_ESM` via jsdom).
  `.nvmrc` pins 25.2.1; invoke it by path rather than switching the
  machine-wide nvm symlink.
- **`node:24-alpine` bundles an npm that rejects this lockfile** with
  `EUSAGE`. The Dockerfile pins `npm@11.6.2`.
- **Fly Launch generated a `COPY . /srv/http/` static server** with a
  one-line `.dockerignore`. That would have published `.env.local` and
  `.git` as downloadable files from a local `fly deploy`. Replaced. The
  owner only ever deployed via the GitHub integration, where `.env.local` is
  absent, so nothing leaked.

## Known issues, deliberately left

| Item | Why it stands |
|---|---|
| Runtime image ships devDependencies | `npm audit --omit=dev` reports **0** vulnerabilities; the 8 high-severity advisories are build-time only. A `npm prune --omit=dev` would shrink the image, but the Dockerfile was verified as-is and was not re-verified after a change |
| `curate()`/`narrate()` discard cost when a stage ultimately throws | Spend-cap accounting slightly under-reports failed attempts. Bounded by the one-retry rule |
| `estimated_duration_min` is an integer column | Fractional minutes round. Harmless |
| PWA precache limit raised rather than code-splitting | Zod entered the web bundle via `TourSchema`. Revisit if the bundle grows |
| `?demo=1` flag added to reach the Amsterdam fixture | The default path is now generate → progress → player; the old manual walkthroughs needed a route back |

## Live checkpoints — the remaining work

These need the owner present and spend real money. Estimated total **~$1.40**.

- **L1** — Record real curation and narration cassettes, replacing the
  synthetic ones. First contact between the prompts and Opus 5. ~$0.46.
- **L2** — Full live generation against Supabase. ~$0.46.
- **L3** — `fly deploy`, then generate from the phone over HTTPS. ~$0.46.
- **L4** — **Walk it.** The Definition of Done.

L1 is the one most likely to surface surprises: it is the first time the
prompts, the strict-JSON expectations, the segment-length bounds and the
2N+1 structural validation meet a real model rather than a fixture written
to satisfy them.
