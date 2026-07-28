# Tour Generation Pipeline (Plan 2a) — Design

**Date:** 2026-07-28
**Status:** Approved, ready for implementation planning
**Supersedes:** nothing. Extends `2026-07-28-ai-city-tours-design.md` (the parent spec)
**Depends on:** `plan-1-outcome-and-carry-forward.md`

## 1. What this builds

The parent spec's §6 pipeline, made real: a deployed service that turns free
text into a walkable, AI-narrated tour of Bratislava's old town, generated on
demand from the phone.

**Definition of Done.** You open the app on your phone, type what you're
interested in, pick a language, wait about a minute, and walk a real tour of
real places with narration written for you. This retires Plan 1's outstanding
"never run on a real phone" item at the same time.

### Scope

Plan 2 was too large for one plan. It is split three ways; this spec covers
**2a** only.

| | Deliverable |
|---|---|
| **2a** *(this spec)* | Supabase + Hono + the four pipeline stages + a generate screen |
| **2b** | Toponym spike → Chirp 3 HD → MP3s → `HtmlAudioPlayer` swap |
| **2c** | Semantic cache (pgvector) + split audio bodies/hooks |

Narration in 2a is still spoken by `speechSynthesis`. Voice is 2b's problem.

### Non-goals

Accounts, payments, multi-city support, turn-by-turn navigation, offline map
tiles, and the semantic cache. Also explicitly out: any attempt to make the
route step-free at the *routing* level (see §5.3).

## 2. Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Runtime | Deployed service, not a local script | Chosen over a local CLI; generation must work from the phone with no laptop running |
| Target city | **Bratislava old town** | The author lives there and can re-walk a fix in ten minutes |
| Languages | The parent spec's six **plus Slovak** | Chirp 3 HD supports `sk-SK`; Slovak is the control in 2b's toponym spike |
| Orchestration | Durable job row, in-process async execution | Phones sleep during a 60s generation and kill the SSE socket |
| Abuse gate | Passphrase + hard daily spend cap | Public endpoint with a paid API key behind it |
| Development cost | Record/replay cassettes, replay by default | Development must not spend money |
| Repo layout | npm workspaces | Client and server share the `Tour` type; duplication guarantees drift |

## 3. Findings that changed the design

Measured before any code was written, against the real city.

### 3.1 Density is fine; curation is a selection problem

81 geo-tagged English Wikipedia articles within 1 km of Hlavné námestie; Slovak
Wikipedia returns 400+. There is no sufficiency problem, so curation can be
built the straightforward way — pick the best 8–12, not scrape for enough.

### 3.2 Geo-tagged does not mean "a place"

That 81 includes *Bratislava Region*, *Timeline of Bratislava*, *Pozsony
County*, *List of ambassadors of Italy to Slovakia*, *2022 Bratislava shooting*
and *Bratislava 1*. The Slovak set adds political parties. Discovery must filter
on Wikidata `P31` and dedupe on QID; geo-tagging alone is not a POI test.

### 3.3 The old town breaks the parent spec's trigger model

Roland Fountain, the Old Town Hall, Apponyi Palace, the Maximilian Fountain and
the Jesuit Church are all on or touching Hlavné námestie — tens of metres apart.
Michalská and Ventúrska are exactly the narrow streets where GPS degrades to
30–50 m. The parent spec's accuracy-adaptive radius, `max(25, accuracy)`,
therefore grows *larger than the spacing between stops*: the engine cannot
distinguish stops that GPS itself cannot resolve.

**The fix belongs in curation, not the engine.** Curate to *stops* — places you
stand — not to *POIs* — things that exist. One stop is "Hlavné námestie", and
its narration covers the square, the fountain, the town hall and Čumil together.
That is what a human guide does.

Plan 1's Amsterdam fixture had 165 m spacing and hid this completely.

### 3.4 Two parent-spec open questions are closed

Chirp 3 HD supports **Slovak (`sk-SK`)** and **does support SSML `<phoneme>`**
with IPA — Preview, and non-streaming requests only. That closes parent §11.2
and substantially de-risks §11.1: if raw pronunciation of *Hviezdoslavovo
námestie* is unacceptable there is a real fallback short of changing vendor.

The parent spec's "31 languages" figure for Chirp 3 HD is stale; it is 50+.

### 3.5 The parent spec's cost figure was optimistic

Parent §10 gives ~$0.35 for curation plus narration. It does not account for
adaptive thinking tokens, which bill at the output rate. Measured properly at
Opus 5's $5/$25 per MTok:

| Item | Tokens | Cost |
|---|---|---|
| Curation input (~100 POIs with summaries) | ~16k in | $0.08 |
| Curation output | ~1.5k out | $0.04 |
| Narration input (10 stops, full extracts) | ~9k in | $0.05 |
| Narration output (~30,000 chars) | ~7.5k out | $0.19 |
| Narration thinking | ~4k out | $0.10 |
| **Total** | | **~$0.46** |

Two mitigations, neither costing quality, both required by this spec:

- **Two-stage context.** Curation receives name, type, coordinates and one line
  per candidate. Full Wikipedia extracts are fetched only for the 8–12 stops
  that survive. Curation input drops from ~16k to ~5k tokens.
- **Prompt caching** on the candidate block, which is byte-identical across every
  generation for a city. Cached reads are 90% off.

Together these take curation from ~$0.12 to ~$0.04. Narration stays ~$0.34 and
that is the floor — it is 5,000 words of bespoke prose, and it is the product.

Parent §10 should be corrected to ~$0.46 cold.

## 4. Architecture

### 4.1 Repo layout

```
apps/web          existing React PWA — moved, not rewritten
apps/api          Hono service: routes, pipeline stages, providers
packages/shared   Tour/Segment types, Zod schemas, geo helpers
```

The workspace migration touches every path in `vite.config.ts`, `tsconfig`, the
PWA config and the test setup, on an app that currently works. It is mechanical
but not free, and it is exactly the kind of change that breaks a build in a way
unit tests do not catch. It is its own first task, gated on `npm run build` and
all 73 existing tests staying green.

### 4.2 Request flow

```
POST /api/tours { city, profileText, language, persona, budgetMin }
  → passphrase check, daily-cap check
  → INSERT job (status=queued) → return { jobId }   [immediately]
  → pipeline runs async, in-process

GET /api/tours/:jobId/events    SSE, reconnectable, resumes from job row
  ← discovery → curation → routing → narration → done | failed

GET /api/tours/:tourId → Tour JSON → IndexedDB → the existing player
```

**The player does not change.** It consumes a `Tour`; where that `Tour` came
from is not its concern. This is the first payout on Plan 1's provider
abstraction — the whole generation subsystem lands behind an interface the
player already speaks.

Client-side additions are limited to a generate screen, a progress screen
reading the SSE stream, and an IndexedDB write on completion.

### 4.3 Why a durable job row

Generation takes about a minute. The most natural thing a user does during a
wait is pocket the phone — which suspends the tab, kills the SSE socket, and
under a pure-streaming design loses the work and the $0.46. Coming back to a
spinner that will never finish is a guaranteed first-walk experience.

The job row is not a job queue. There is no Redis and no separate worker; the
pipeline still runs as an async function in the Hono process. The only change is
that progress lives in a table instead of only in a socket. Three benefits fall
out of one column, `jobs.stage_output`:

- SSE reconnect state
- retry-one-stage instead of paying for all four
- the per-stage cassette boundary (§6)

## 5. The pipeline

### 5.1 Stage 1 — Discovery

Runs **once per city**, caches to `pois`, and is never in the per-tour path.
Wikidata SPARQL times out, Overpass rate-limits, and both go down; none of that
may break generation in a city already discovered.

The `P31` filter walks the subclass graph rather than enumerating type IDs — a
hand-maintained list of forty leaf types is a list still being patched in six
months:

```sparql
?item wdt:P31/wdt:P279* ?type .
VALUES ?type { wd:Q811979   # architectural structure
               wd:Q4989906  # monument
               wd:Q174782   # square
               wd:Q33506 }  # museum
```

Four roots instead of forty leaves. *Bratislava Region*, *Pozsony County* and
*2022 Bratislava shooting* fall out because none is a subclass of a structure.
The same query returns coordinates, labels in all seven languages, and sitelinks
in one round trip.

Two enrichments:

- **Wikipedia** batch extract API supplies intro paragraphs in English and
  Slovak, keyed off the sitelinks. Intros only at this stage.
- **OSM Overpass** supplies `wheelchair` and `step_count`, joined on OSM's own
  `wikidata=Q…` tag — not by name. Names are ambiguous in a city with three
  historical languages; QIDs are not.

### 5.2 Stage 2 — Curation

One Opus 5 call, structured outputs, `strict: true`.

In: candidate list (name, types, coordinates, one line, step-free flag), the
user's free text, time budget, target language. Out:

```
{ tourTitle, stops: [ { wikidataQids[], standingPoint{lat,lng},
                        title, why, order } ] }
```

A **standing point** is where you stand to see the stop, and is generally not
any single POI's coordinate — for a square it is the centre; for St Martin's it
is across the road where the spire is visible. It is a required output field,
not something derived by averaging coordinates.

Three validations in code, because the schema guarantees shape, not truth:

1. **Every returned QID must exist in the candidate set.** Absolute
   anti-hallucination guard: Opus cannot invent a palace, because anything not
   in the input list is rejected. This closes parent §12's "LLM invents facts"
   risk structurally at selection, rather than hoping a prompt holds.
2. **8–12 stops, ≥100 m apart.**
3. **The user's free text is delimited and declared as data, never
   instructions** (parent §7). A profile reading "ignore previous instructions
   and…" is a preference about tour content and is treated as one.

On failure: **one** retry with the specific error fed back, then fail the job
with a real message. Bounded retries everywhere — an unbounded retry against a
paid API is the second way to wake up to a large bill.

### 5.3 Stage 3 — Routing

Mapbox Directions, `walking` profile, waypoints = standing points in curated
order. The 25-waypoint ceiling is not a constraint at 8–12 stops.

- Geometry decodes to the `LineString` the player already consumes.
- **Walk cues sit ~25% along each leg** — Plan 1's settled convention, and
  `fractionAlongLineString` in `src/lib/geo.ts` already computes the position.
- **Trigger radius is derived, not authored:**

  ```
  triggerRadiusM = min(60, max(25, 0.4 × distanceToNearestStop))
  ```

  With ≥100 m separation guaranteed by curation, two adjacent stops get 40 m
  each and a 20 m gap. Radii cannot overlap by construction.

- **Estimated duration** = Σ leg durations + Σ dwell, where dwell is the
  script's estimated speaking time (~15 chars/second) plus 60 s of lingering.
- **Budget check:** if the estimate exceeds `budgetMin × 1.15`, re-curate
  **once** with the measured overage. Never silently deliver a 90-minute walk
  to someone who asked for 45.

**Scoped down, deliberately.** Parent §7 says OSM `wheelchair`/`step_count`
tags can be "weighted against" during routing. Mapbox's walking profile exposes
no step-avoidance parameter, so in 2a step-free is a **curation filter** —
exclude POIs tagged `wheelchair=no` — and a narration note, not a routing
weight. Real step-free routing needs a different router and is out of scope.

### 5.4 Stage 4 — Narration

**One Opus 5 call per (tour, language)**, streaming, producing every segment in
one pass. Per-segment calls would parallelise and shorten each output, but they
lose narrative coherence — callbacks between stops, "the same architect you saw
at the cathedral" — and coherence is a large quality lever on a guided walk.

In: full Wikipedia extracts (English and Slovak) for the selected stops, route
legs with distances, the persona free text, the profile free text, the target
language. Out, strict JSON:

```
segments: [ { order, kind, title, script } ]
```

For N stops the sequence is `intro`, then `stop`/`walk` alternating, then
`outro` — 2N+1 segments.

Validations: the kind sequence matches the route; every `stop` maps to a curated
stop; script lengths are within bounds (400–1400 characters for stops, 120–350
for walk cues). Same one-retry rule as curation.

**Content rules** carried from the parent spec: write natively in the target
language, never translate finished narration; say both names on first mention
(*"Main Square — or as the signs read, Hlavné námestie"*).

**One language per request.** Stages 1–3 are language-independent, but 2a
generates only the language the user asked for. Generating all seven eagerly
would cost 7× for six tours nobody requested.

`tours` stays denormalised in 2a — one row per (plan, language), route JSON
duplicated across languages. Normalising into `tour_plans` + `tours` matters
only when the cache does, which is 2c.

## 6. Development without spending money

Every external call sits behind an interface with a recorded implementation:
Wikidata, Wikipedia, Overpass, Mapbox Directions, Anthropic.

| Mode | Behaviour | Used by |
|---|---|---|
| `replay` | Cassette required. A miss is a **loud failure** naming what to record. | All tests, all normal dev — the default |
| `record` | Real calls, writes cassettes, prints estimated cost, requires an explicit env var | Deliberate, occasional |
| `live` | Real calls, no writes | Production |

**The hard failure on a cassette miss is the point.** A "fall back to live if no
cassette" design fails open, in the direction of money, silently.

**Per-stage cassettes, not per-pipeline.** Iterating on the narration prompt
replays stages 1–3 from disk and calls the model only for stage 4 — about $0.34
instead of $0.46, and ten seconds instead of sixty. This is the same seam as
`jobs.stage_output`.

**Cassette provenance.** Discovery and routing cassettes are recorded against
the real APIs (Wikidata, Wikipedia and Overpass need no key; Mapbox uses the
existing token). Curation and narration cassettes start **hand-authored and
explicitly marked synthetic**, and are replaced by real recordings the first
time `record` runs with a real Anthropic key.

**One golden tour**, recorded early — a complete real Bratislava generation
committed to the repo, ~$0.46 once. It replaces the hand-authored Amsterdam
fixture and becomes the input for the generate UI, the player integration and
all of 2b.

### 6.1 What cassettes cannot test

Schema drift at Wikidata, an Overpass rate limit, a Mapbox 422 on an unroutable
standing point, and above all Opus returning JSON that misses the schema or
prose that runs 3× the expected length — none of this appears in replay.

Plan 1's sharpest lesson was that 68 green tests and a clean build still
produced a white screen on first run, because nothing could execute the app. The
same failure is available here.

The plan therefore carries **deliberate live runs as gated checkpoints**, and
the Definition of Done requires one true end-to-end live generation on the
phone. Estimated Anthropic spend for the whole plan: the golden tour, six to
eight stage-4-only prompt iterations, and two or three full live runs —
**$5–8**, against $15–25 without this discipline.

## 7. Data model

```sql
cities    slug, name, bbox geography(Polygon), discovered_at
pois      city_id, wikidata_qid UNIQUE, names jsonb, point geography(Point),
          p31_types text[], wiki_en_title, wiki_local_title,
          summary_en, summary_local, osm_id, wheelchair, fetched_at
tours     city_id, language, persona, profile_text, title,
          route jsonb, estimated_duration_min, created_at
segments  tour_id, "order", kind, title, script, audio_url, duration_ms,
          trigger geography(Point), trigger_radius_m, poi_ids uuid[]
jobs      city_id, status, stage, request jsonb, stage_output jsonb,
          tour_id, error, cost_usd, created_at, updated_at
```

No pgvector yet — 2c adds it, and a nullable column is a trivial migration.
No budget table — the daily cap is `sum(cost_usd) where created_at > today`,
and `cost_usd` is **measured** from each API response's reported token usage,
not estimated, so the number being capped is the number actually billed.

### 7.1 Changes to the shared types

`Segment.poiId: string | null` becomes **`poiIds: string[]`** — the direct
consequence of §3.3.

### 7.2 Repository abstraction

Data access sits behind a `TourRepository` interface with two implementations:
`InMemoryTourRepository` for tests and `PostgresTourRepository` for real use.
Tests never require a database.

This is not only aesthetic: Docker Desktop is installed on the development
machine but its daemon is not running, so a local Postgres is not reliably
available. The in-memory implementation keeps the entire suite runnable
regardless, and Postgres is exercised in the live smoke checkpoints.

## 8. Error handling

- **Stages do not throw across their boundary.** Each returns a typed result;
  the orchestrator records `status=failed`, the stage that failed, and a
  human-readable message on the job row.
- **SSE emits an error event**; the progress screen names the failed stage and
  offers retry. Retry resumes from that stage using `stage_output`, so a
  narration failure does not re-pay for discovery, curation and routing.
- **External APIs:** three attempts with backoff on 5xx and timeouts; no retry
  on 4xx, which will not fix itself.
- **Anthropic:** exactly one re-ask on a validation failure, as specified in
  §5.2 and §5.4. No further retries.
- **Caps:** whole-pipeline timeout and per-stage timeouts. Daily spend cap
  returns 429 with a message that says so.

## 9. Testing

- Unit tests per stage against cassettes; deterministic, offline, free.
- Zod schemas as contract tests on every boundary — the two Opus outputs, the
  POST body, the `Tour` handed to the client.
- **Golden-tour test:** the full pipeline in `replay` produces a byte-stable
  `Tour`, snapshotted.
- **Trigger-engine regression tests for co-located stops** — the §3.3 case, with
  two stops 60 m apart and 50 m accuracy, asserting the nearer one fires and
  neither counter thrashes.
- All 73 existing tests stay green throughout.

**Node version.** The suite cannot run on Node 20.17.0 (`ERR_REQUIRE_ESM` via
jsdom) and the machine's nvm symlink currently points there. `.nvmrc` pins
25.2.1; tooling must invoke that version by path rather than switching the
machine-wide symlink.

## 10. Security

- **Passphrase** on the generate endpoint, stored in `localStorage` after first
  entry. Crude, and the right crude: it stops drive-by discovery of a public
  endpoint with a paid key behind it.
- **Hard daily generation cap**, server-side, returning 429. This is what
  actually bounds damage — a passphrase leak is survivable, a retry loop at
  $0.46 a call overnight is not.
- **Free text is data, not instructions** (§5.2). Delimited, declared, and
  moderated before it reaches generation.
- **Secrets never enter the repo or the conversation.** `.env.local` for local
  work, `fly secrets` for deployment. The existing Mapbox token stays where it
  is.

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Opus returns prose that overruns the segment length bounds, making a 45-min tour 90 | Medium | Length validation with one re-ask; duration estimated from actual script length, not stop count |
| Standing points land inside buildings or on the wrong side of a road | Medium | Mapbox snaps waypoints to the walking network; unroutable points fail the stage loudly rather than silently relocating |
| Wikidata SPARQL flakiness blocks generation | Low | Discovery is cached per city and never in the per-tour path |
| Curation picks 12 stops a tourist would not walk between | Medium | Budget feedback loop; ≥100 m separation is a floor, not a target |
| Cassette-driven development hides real API behaviour | High | Gated live checkpoints; DoD requires a real end-to-end run (§6.1) |
| Workspace migration breaks the working Plan 1 app | Medium | Its own first task, gated on the full suite and a clean build |

## 12. Open questions

1. **Passphrase distribution.** Fine for one user; needs rethinking the moment
   a second person walks a tour.
2. **Prompt-cache TTL vs. discovery refresh.** If a city is re-discovered, the
   cached candidate block changes and cache hits reset. Not a correctness issue.
3. **Slovak narration quality** is unmeasured. It is the control for 2b's
   toponym spike, but nobody has read Opus 5's Slovak prose about Bratislava
   yet.
4. **Dwell-time constant.** 60 s of lingering per stop is a guess and will need
   tuning against a real walk.
