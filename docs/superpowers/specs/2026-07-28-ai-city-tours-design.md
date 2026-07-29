# AI-Guided City Tours — Design

**Date:** 2026-07-28
**Status:** Approved, ready for implementation planning

## 1. What we're building

A mobile-first web app that generates personalised, GPS-triggered audio walking
tours. The user describes what they're interested in, in their own words; the
system builds a walking route through real places, writes narration grounded in
real sources, speaks it in a chosen voice, and plays each segment automatically
as the user arrives at it.

Comparable product: [iWander](https://iwander.io/) — AI-generated audio tours,
GPS-triggered narration, four fixed guide personas, offline after download,
iOS-only at time of writing. Our differentiators are **free-text
personalisation** (rather than picking from preset themes) and **instant web
access** (no install, both platforms on day one).

### First release: working prototype

One or two cities, runs on the author's own phone, no accounts, no payments.
The goal is to prove the core loop feels good: *describe what you like → get a
route → walk it → narration fires at the right moment*.

### Non-goals for the prototype

- Accounts, auth, payments, subscriptions
- Interruptible live Q&A ("what's that building?")
- Mid-walk adaptation to behaviour or weather
- Cross-tour memory
- Curated/human-authored tours

These are deliberately excluded. The personalisation model in §7 is
profile-driven generation only.

## 2. The governing constraint: background GPS on mobile web

Mobile browsers suspend JavaScript when the screen locks or the tab
backgrounds. There is no web equivalent of iOS Core Location background updates
or an Android foreground service.

| Capability | Mobile web |
|---|---|
| `watchPosition()` in foreground | Works well, ~1s updates |
| GPS with screen locked / backgrounded | **Not available** |
| Keep screen awake | Screen Wake Lock API (iOS 16.4+, Android Chrome) |
| Audio autoplay | Requires one user gesture; afterwards a persistent `<audio>` element can have `src` swapped and `.play()` called programmatically |
| Lock-screen transport controls | Media Session API |
| Offline audio | Service worker + Cache Storage |

**Accepted UX:** phone in hand, screen on, tab foregrounded, wake lock held.
Acceptable for a walking tour — people hold their phone to follow the map — but
it costs battery and rules out "pocket your phone and just listen".

**Mitigation — provider abstraction from day one:**

```
LocationProvider  →  BrowserLocation | SimulatedLocation | NativeLocation (later)
AudioPlayer       →  WebAudioPlayer  | NativeAudioPlayer  (later)
TtsProvider       →  GoogleTts       | ElevenLabsTts
```

Consequences:

- **Capacitor** can later wrap the same React app and supply true background
  geolocation and audio. A provider swap, not a rewrite.
- `SimulatedLocation` (§9) makes the trigger engine testable without walking.
- `TtsProvider` keeps the voice-vendor decision reversible (§4).

## 3. Stack

| Layer | Choice | Rationale |
|---|---|---|
| App | Vite + React 19 + TypeScript, PWA via `vite-plugin-pwa` | ~95% client-side interactive (map, GPS, audio). SSR buys nothing; service-worker config is simpler than Next App Router. |
| Styling | Tailwind CSS v4 | Mobile-first, fast iteration on single-screen UI. |
| Map + routing | Mapbox GL JS + Mapbox Directions (walking profile) | One vendor, one token. Free tier 50k map loads + 100k directions/month. |
| API | Node + TypeScript + Hono, on Fly.io | Long-running process — a 60s generation streams progress over SSE instead of fighting serverless timeouts. |
| Data | Supabase — Postgres + PostGIS + pgvector + Storage | Collapses DB, geo queries, semantic cache and MP3 hosting into one vendor. Auth available when accounts are added. |
| POI grounding | Wikidata + Wikipedia geosearch + OpenStreetMap (Overpass) | Free; supplies the coordinates the trigger engine needs anyway. |
| Generation | Claude Opus 5 (`claude-opus-5`), adaptive thinking, streaming | Latency-tolerant batch work where output quality is the entire product. |
| Extraction | Claude Haiku 4.5 (`claude-haiku-4-5`) | Cheap structured parse of user free text. |
| Voice | Google Chirp 3 HD | See §4. |

**Known lock-in:** Mapbox. MapLibre GL JS is an API-compatible fork, so
swapping the render layer later is small — but requires changing tile provider
(Protomaps or MapTiler) at the same time, since Mapbox tiles require Mapbox GL
JS.

**No job queue in the prototype.** Generation runs inline on the Hono process
and streams progress via SSE. A queue is a later concern.

## 4. Voice provider

Verified pricing, ~30,000 characters per 40-minute tour:

| Provider / voice | $ / 1M chars | $ / 40-min tour | Free tier | Languages |
|---|---|---|---|---|
| Google WaveNet | $4 | $0.12 | — | 40+ |
| Google Neural2 | $16 | $0.48 | 1M chars/mo | 40+ |
| **Google Chirp 3 HD** | **$30** | **$0.90** | **1M chars/mo** | **50+** |
| Azure Neural | $16 | $0.48 | 500k chars/mo | 140+ locales |
| Azure Neural HD | $22 | $0.66 | 500k chars/mo | — |
| ElevenLabs Flash v2.5 | ~$83 eff. | $2.50 | 10k credits | 32 |
| ElevenLabs Multilingual v2 | ~$166 eff. | $5.00 | 10k credits | 29 |

ElevenLabs credits run ~$0.165–0.18 per 1,000; Multilingual v2 consumes 1
credit per character, Flash/Turbo v2.5 consumes 0.5. Tier ceilings bite as hard
as the rate — Creator ($22/mo, 121k credits) is four tours a month.

**Decision: Google Chirp 3 HD.** ~3× cheaper than ElevenLabs Flash, ~5.5×
cheaper than v2, wider language coverage (50+ vs 32), and its 1M chars/month
free tier covers the entire prototype phase at zero cost. Eight voices (4M/4F)
shared across all languages, so a persona keeps its identity across the whole
catalogue.

*Verified 2026-07-28: Chirp 3 HD now lists 50+ locales, including `sk-SK`.
The earlier figure of 31 was stale.*

**Open question (§11):** foreign proper-noun pronunciation. Every tour is
saturated with local toponyms in a language that is not the narration language
— a Spanish tour of Amsterdam must say *Prinsengracht*. ElevenLabs handles
code-switching noticeably better. Google's counter is SSML `<phoneme>` with
IPA, but Chirp 3 HD's markup surface is more restricted than Neural2's and this
is **unverified**. `TtsProvider` keeps the decision reversible.

## 5. Languages

**English, German, French, Spanish, Italian, Dutch, Slovak.** All seven sit
comfortably inside both Google's and ElevenLabs' coverage, so there is no
provider risk.

*Slovak added 2026-07-28 alongside the choice of Bratislava as the first city.
It is the local language, which makes it the control in the §11.1 toponym
spike: it is the only voice that pronounces the street names correctly by
construction, so it defines what the other six should sound like.*

**Ground in English, write in the target language.** Wikipedia's language
editions have uneven geo coverage; English has substantially more geo-tagged
articles. Sourcing from the target-language edition would make non-English
tours thin.

```
Wikidata (language-agnostic IDs, coordinates, multilingual labels)
  + English Wikipedia (grounding)
  + local-language Wikipedia via Wikidata sitelink, always
  + target-language Wikipedia via Wikidata sitelink, where it exists
       ↓
  Claude Opus 5 writes natively in the target language
```

*Amended 2026-07-28 to always pull the **local**-language article, regardless of
narration language. Measured in Bratislava: English has 81 geo-tagged articles
within 1 km, Slovak has 400+, and individual burgher houses — Jakubov dom,
Ungerov dom, Pawerov dom — have Slovak articles and no English one. English
remains the spine; the local edition is what makes the difference between "a
baroque palace on Ventúrska" and something specific. Opus 5 reads the source
language without needing it translated first.*

Do **not** translate finished narration — translated tour copy reads stilted.
Generate directly in the target language.

**Content rule:** say both names on first mention — *"Old Town Square — or as
the signs read, Staroměstské náměstí."* Tourists need the translated name to
understand and the local name to navigate. Wikidata supplies both.

## 6. Generation pipeline

| # | Stage | Output | Cache scope |
|---|---|---|---|
| 1 | **Discovery** — Wikidata SPARQL + Wikipedia geosearch + OSM Overpass over city bbox | ~150 candidate POIs: coords, types, multilingual names, summaries | per city |
| 2 | **Curation** — Opus 5 selects and orders 8–12 stops for the profile | ordered stop list (strict JSON schema) | per city + profile (semantic, §7) |
| 3 | **Routing** — Mapbox Directions, walking, chained through stops | polyline, per-leg distance/duration | per city + profile |
| 4 | **Narration** — Opus 5 writes stop bodies + walking cues, in persona, in target language | script segments | per city + profile + language + persona |
| 5 | **Voice** — Chirp 3 HD per segment → MP3 → Supabase Storage | audio files | content hash of script text |

**Stages 1–3 are language-independent.** A 90-minute architecture walk through
Amsterdam visits the same buildings in the same order in German and in Italian.
Six languages therefore costs 6× on stages 4–5 only.

**Budget feedback loop:** if stage 3 returns a route over the user's stated time
budget, feed the overage back into stage 2 and re-curate. Never silently
deliver a 90-minute walk to someone who asked for 45.

## 7. Personalisation — free text first

The user writes whatever they want, in any of the six languages:

> *"I'm into brutalist architecture and I hate crowds. Been here twice already.
> Bad knee, so nothing steep."*

```
free text
   ↓ extract (Haiku 4.5)          → structured hints + raw text kept verbatim
   ↓ embed  (→ pgvector)          → semantic cache key
   ↓ route  (semantic cache hit?) → reuse existing route, or generate
   ↓ narrate                      → shared body + personalised hook/aside
```

### Semantic caching

Exact-key caching cannot work with free text. Instead, embed the extracted
profile and look up existing tours for the city by cosine distance. Above ~0.90
similarity, reuse the route; below, generate fresh and store the embedding.
"Brutalist architecture, avoid crowds" and "concrete modernism, off the beaten
path" land on the same walk with different narration.

pgvector ships with Supabase — no additional infrastructure.

### Split audio: shared body, bespoke hook

| Part | Length | Keyed on | Shared |
|---|---|---|---|
| **hook** | 5–15s | user's raw text | no |
| **body** | 60–180s | (poi, depth, language, persona) | **yes** |
| **aside** | 10–20s, optional | user's raw text | no |

The facts about a building don't change between users; how you're introduced to
it does. Audio caches on a **content hash of the script text**, decoupling reuse
from profiles entirely. A bespoke tour on a warm city personalises ~5,000
characters instead of ~30,000.

### Persona

Also free text — *"talk to me like a grumpy local historian who's tired of
tourists"* — mapped to the nearest of the 8 Chirp voices by gender and timbre,
with the user's own phrasing fed into the writing prompt.

### Onboarding

One text box, optional voice input, plus example chips (*"brutalist
architecture"*, *"somewhere my kids won't get bored"*, *"food, but not tourist
traps"*). **Chips write into the box rather than filtering** — people who know
what they want type; people who don't get a nudge.

Profile persisted to `localStorage` for the prototype; no accounts.

### Handling free text safely

- **Treat it as data, not instructions.** Delimit user text in the generation
  prompt and instruct the model to read it as preferences only, never as
  commands. Otherwise prompt injection is a live surface.
- **Moderate before it reaches the voice.** The guide must not read abusive
  content back in a warm, confident narrator's voice.
- **Surface conflicts.** "A deep dive on everything, in 30 minutes" is
  unsatisfiable; the extraction pass detects it and the UI confirms the tradeoff
  rather than silently choosing.

### Accessibility

Step-free routing is the one preference that changes *routing* rather than
prose. OSM carries `wheelchair` and `step_count` tags that can be weighted
against. Cheap to implement, badly underserved by competitors, and a genuine
reason to choose this product.

## 8. GPS trigger engine

```
onPosition(fix):
  if fix.accuracy > 50m: return              // urban canyon garbage, discard

  next = segments[cursor]
  d = haversine(fix, next.trigger)
  radius = max(next.radius, fix.accuracy)    // adapt to real-world accuracy

  if d < radius:
    hits++
    if hits >= 2: fire(next); cursor++       // hysteresis: 2 consecutive fixes
  else:
    hits = 0
```

Rules:

- **Only the next expected stop auto-fires.** Otherwise walking back past stop 3
  replays it.
- **Allow skip-ahead.** Someone inside stop 6's radius shouldn't wait for 4 and 5.
- **Never interrupt playing audio.** Queue and play on completion.
- **Tap-to-play any stop, always.** GPS will misfire; the worst failure mode is a
  user standing at a cathedral in silence. This escape hatch is what makes the
  product feel reliable.
- **Walk cues fire on departure**, not arrival — "head left down the alley" is
  useless once you've reached the next stop.
- **Off-route detection:** >60m from the route line for >30s → offer directions
  back.

**The accuracy-adaptive radius is not a detail.** GPS in a narrow old-town
street runs 20–50m error. A fixed 25m radius fails *silently* — the tour simply
never triggers and the user cannot tell why.

## 9. Testing

`SimulatedLocation` replays a GeoJSON `LineString` at configurable speed with
injected accuracy noise and dropout. A dev panel provides play / pause / scrub /
speed / jump-to-stop / inject-bad-fix.

This makes the trigger engine a pure function over a sequence of fixes —
unit-testable, and iterable in seconds rather than afternoons of walking.

Chrome DevTools' geolocation override sets a single static point and is not
sufficient.

## 10. Cost model

Per bespoke tour, **warm city** (route cache hit):

| Item | Cost |
|---|---|
| Extraction + embedding | ~$0.01 |
| Route (semantic hit) | $0 |
| Personalised narration (~2k output tokens) | ~$0.05 |
| Personalised TTS (~5k chars @ $30/1M) | ~$0.15 |
| **Total** | **~$0.21** |

Per tour, **cold city** (full generation, single language):

| Item | Cost |
|---|---|
| Claude Opus 5 — curation + full narration | ~$0.46 |
| Chirp 3 HD — ~30k chars | ~$0.90 |
| Maps | negligible |
| **Total** | **~$1.36** |

*Corrected again 2026-07-29, this time from receipts rather than arithmetic.
**Measured: ~$0.79** — curation $0.35, narration $0.44. Both earlier figures
($0.35, then $0.46) were derived from token counts that under-counted adaptive
thinking, which bills at the output rate and dominates: one curation call spent
7,182 thinking tokens against 1,500 of actual JSON.*

*Prompt caching works as designed (17k cached input tokens per call), but it
discounts input, and input is not where the money goes.*

*The figure was ~$1.14 until curation was given an explicit walking-distance
budget: without one it overshot a 60-minute request by 31%, tripping the
over-budget re-curation on essentially every realistic request and paying for
curation twice. See `plan-2a-outcome-and-carry-forward.md`.*

Claude Opus 5 is $5 / $25 per MTok input / output. Chirp 3 HD's 1M chars/month
free tier covers roughly 33 full tours — the entire prototype phase costs
approximately zero on voice.

Localising a template into all six languages costs ~6 × ($0.15 narration +
$0.90 TTS) ≈ $6.30, against a one-time ~$0.20 for discovery, curation and
routing.

## 11. Open questions and spikes

1. **Toponym pronunciation (highest priority).** Generate a page of real
   **Bratislava** street names — *Hviezdoslavovo námestie*, *Františkánske
   námestie*, *Michalská brána*, *Primaciálny palác*, *Ventúrska* — in Spanish,
   German and Italian Chirp 3 HD voices and listen, with the Slovak voice as the
   control. Half a day, before any TTS integration is written.

   *Retargeted from Amsterdam 2026-07-28. Slovak orthography — ľ, ť, ď, ň, č, š,
   ž and heavy consonant clusters — in voices with no Slovak phonology is a
   far harsher test than Dutch. The risk is front-loaded: if Chirp survives
   Bratislava, Amsterdam and Prague are easy.*

2. ~~**Chirp 3 HD SSML surface.**~~ **Resolved 2026-07-28.** Chirp 3 HD does
   support SSML including `<phoneme>` with IPA — marked Preview, and **not
   supported on streaming requests**, only synchronous ones. This gives §11.1 a
   real fallback short of changing vendor, at the cost of forcing non-streaming
   synthesis wherever phoneme overrides are used.
3. **Gemini TTS.** Supports natural-language style prompting ("read this
   warmly, like sharing a secret"), which maps directly onto free-text personas
   in a way fixed-voice APIs don't. Current per-character pricing not verified.
4. **Semantic cache threshold.** The ~0.90 cosine figure is a starting guess.
   Needs tuning against real prompts — too tight and nothing caches, too loose
   and users get a walk that doesn't match what they asked for.
5. **Wake lock behaviour** across iOS Safari versions and in standalone PWA
   (added-to-home-screen) mode.
6. ~~**Target cities**~~ **Resolved 2026-07-28: Bratislava old town.** Chosen
   because the author lives there and can re-walk a fix in ten minutes rather
   than on the next trip. Measured density: 81 geo-tagged English Wikipedia
   articles within 1 km of Hlavné námestie, 400+ on Slovak Wikipedia.

   It also surfaced a defect in §8 before any pipeline code existed: old-town
   POIs sit tens of metres apart while GPS accuracy in Michalská and Ventúrska
   runs 30–50 m, so the accuracy-adaptive radius grows larger than the spacing
   between stops. See the Plan 2a spec §3.3 — the fix is to curate to *stops*
   (places you stand) rather than *POIs* (things that exist).

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Screen-on requirement makes the experience feel worse than native | High | Accepted for prototype; provider abstraction makes Capacitor a swap, not a rewrite |
| Toponym pronunciation is unacceptable in non-native voices | High | Spike before integration (§11.1); `TtsProvider` keeps vendor reversible |
| GPS accuracy in dense old towns causes silent trigger failures | High | Accuracy-adaptive radius, hysteresis, and always-available tap-to-play |
| LLM invents facts about real places | Medium | Wikidata/Wikipedia/OSM grounding; narration generated from supplied context, not memory |
| Semantic cache never hits → every tour costs full price | Medium | Split-audio model keeps bespoke portion to ~5k chars regardless of cache behaviour |
| Prompt injection via the free-text field | Medium | Text delimited and declared as data, not instructions; moderation pass before TTS |
