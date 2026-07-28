# Plan 1 — Outcome and Carry-Forward

**Date:** 2026-07-28
**Status:** Complete. 73 tests passing, `npm run build` exit 0, full walk verified in a browser.

Plan 1 delivered the client-side tour player: a pure `TriggerEngine` driven by a
swappable `LocationProvider`, feeding a swappable `AudioPlayer`, with a Mapbox
map, a simulator harness, real GPS, a wake lock and a PWA shell.

This document records what a later plan needs to know. It exists because the
scratch workspace that held the execution ledger is deleted once the work lands
— the parts worth keeping belong in the repo.

## Verified working

Driven in a real browser against the simulated Amsterdam route at 10×:

```
Welcome → Dam Square → Toward the palace → Royal Palace
        → Westerkerk → Noordermarkt → "That is the walk"
```

Also verified: the accuracy gate discards a garbage fix (injected at 0,0 with
300 m accuracy — ~5,600 km off route — with no off-route alert and no spurious
firing); tap-to-play replays an already-played stop; and with the Mapbox token
removed the app degrades to "Map unavailable right now. The tour will keep
talking as you walk." rather than white-screening.

## Not done — do not assume otherwise

- **Never run on a real phone over HTTPS.** Everything so far ran in a desktop
  browser. The constraint this whole design bends around — mobile browsers
  suspending JavaScript when the screen sleeps — has not been exercised once.
  This is the single most important outstanding verification.
- **Narration has never been confirmed audible.** The state machine was verified
  (which segment is current, queueing, interruption), but the automated browser
  may have zero speech voices installed, in which case `speechSynthesis`
  completes silently and the state machine advances identically.

## Must fix before Plan 2 generates tours

**The trigger engine's hit counter thrashes when two triggerable stops are
simultaneously in range** (`src/lib/trigger/engine.ts`, the `hitSegmentId` /
`hits` reset). If GPS jitter flips which stop is nearest between fixes, `hits`
resets to 0 every time and *neither* segment ever fires. Unreachable with the
hand-authored fixture, whose stops are ≥165 m apart. Generated tours will place
POIs inside a shared radius routinely, and the symptom is silent — narration
simply never arrives, with nothing in the logs. This is spec §8's worst-case
failure reached by a route the spec did not anticipate. A per-segment hit map
rather than a single counter is the obvious fix.

## Conventions Plan 2 must honour

- **Walk-cue triggers sit ~25% along the leg** from the preceding stop —
  unambiguously after departure, comfortably before arrival. The routing stage
  must place them this way. (Three sources disagreed on this during Plan 1; this
  is the settled rule.)
- **`LocationProvider.start()` must not double-register.** Implementations stop
  any existing subscription first. Documented in `src/lib/location/types.ts`.
- **`AudioPlayer.play()` always resolves and never rejects.** A failed segment
  must not stall the tour; failures are logged and resolved.
- **`audio` and `location` must be constructed with stable identities.**
  Constructing either inline in a component body creates a new object every
  render and silently kills a running tour.

## Known limits of the dev simulator

**Speeds above ~10× outrun the trigger engine.** At 20× the simulator advances
~28 m per fix while the trigger window is ~50 m wide and hysteresis requires two
consecutive in-radius fixes, so segments are jumped clean over. The symptom
looks exactly like an engine bug. Run the walkthrough at 10× or below; this is
noted in `docs/TESTING.md`.

## Deferred, deliberately

Judged acceptable to stand at the whole-branch review, with reasoning:

| Item | Why it stands |
|---|---|
| `offRouteAnnounced` stays true after a long gap | Consistent with the documented "once until return" contract; the banner is unaffected |
| `useWakeLock`'s `catch` doesn't check `cancelled` | The path is a no-op either way; the guard itself was traced correct twice |
| `NowPlaying` has no `aria-live` region | Real accessibility gap on an audio-first app — **put it in Plan 2's scope** |
| `manifest.icons` is empty | Needs design assets, not code; disclosed in `docs/TESTING.md` |
| 8 dev-only `npm audit` advisories | `vite-plugin-pwa` → `workbox-build`, build-time only, nothing reaches the bundle |
| `.mp3` runtime-caching rule matches nothing | Forward-looking for Plan 2. **Verify it actually matches once real URLs exist** — signed URLs with query strings will not match `/\.mp3$/` |
| Intro replays on a retry after a failed start | This is a restart, not a duplicate. `audio.stop()` cancels the partial first one |

## Scope decisions taken

- **No turn-by-turn navigation or rerouting.** Route line plus off-route alerts
  is the model, matching the comparable product. Positioning is real GPS;
  guidance is a line on a map and authored walk cues.
- **`speechSynthesis` is a deliberate stand-in.** `HtmlAudioPlayer` is built and
  tested; switching is one line in `src/App.tsx` once Plan 2 produces MP3s.

## Process note

Seven of eight tasks found real defects in the plan's own code, and the two
sharpest defects lived *between* tasks rather than inside any one of them —
one task's contract versus another's usage. The per-task gate never sees those.
A cheap explicit seam pass at the end of a plan, tracing each cross-module call
chain once, would have caught both.

The single most valuable check was running the app. Eight tasks, twenty-odd
review rounds, 68 passing tests and a green build — and the first tap produced a
blank white page, because a third-party constructor threw at runtime where no
static review or unit test could see it.
