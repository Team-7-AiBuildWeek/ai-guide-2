# Manual testing

## Node version — read this first

This machine's default Node (20.17.0) cannot run the test suite: `npm test`
dies with `ERR_REQUIRE_ESM` somewhere inside jsdom's dependency chain. `npm
run build` still succeeds on 20.17.0 — a green build proves nothing about
whether the tests pass, so don't take it as a substitute for `npm test`.

`vite` and `jsdom` both require Node `^20.19.0 || >=22.12.0`. `package.json`'s
`engines` field declares that same range; it does not pin an exact version.
The exact version this repo is built and tested against, `25.2.1`, is pinned
only in `.nvmrc`. Before running any `npm` command in this repo, put that
Node first on `PATH`:

```bash
export PATH="/c/Users/palo/AppData/Local/nvm/v25.2.1:$PATH"
```

Do **not** run `nvm use` — on Windows that rewrites a machine-wide symlink,
which is not this repo's to change. If you ever see `ERR_REQUIRE_ESM`, you
forgot the `export PATH=...` line above; it is not a bug in the code.

## Simulated walk (no walking required)

1. `npm run dev`
2. Open `http://localhost:5173/?sim=1` in a browser
3. Tap **Start the walk** — the intro narration should speak immediately
4. **StrictMode check (open question, not an assumption):** right now,
   before doing anything else below, open the browser console and watch it
   as the map mounts. React StrictMode double-invokes effects in dev, and it
   is not yet confirmed whether a stale `load` handler from the first
   (discarded) `mapbox-gl` `Map` instance can fire against the second
   instance. Watch for either symptom:
   - a mapbox error to the effect of "already a source" / "already a layer", or
   - stop markers appearing twice (duplicated pins on the map, or duplicate
     entries reacting to clicks)
   Record whether either symptom appears. This is a real open question about
   effect cleanup ordering under StrictMode, not a formality — do not assume
   it's fine because the build is green.
5. Open the `dev` panel, set speed to 10×
6. Expect, in order: Dam Square → toward the palace → Royal Palace →
   Westerkerk → Noordermarkt, each speaking on arrival
7. Tap **inject bad fix** — nothing should fire (the engine's accuracy gate
   discards it)
8. Tap a stop in the bottom list — it should play immediately, interrupting
   whatever is speaking
9. **Reload the page and tap Start the walk again.** This is required, not
   optional: step 6 already marked every stop, including Noordermarkt, as
   played, and the trigger engine permanently excludes played segments from
   firing again by position. Testing "jump to" on Noordermarkt against the
   same run as step 6 would silently do nothing regardless of whether the
   target coordinate is correct — that's the played-set behaving as
   designed, not a regression. A fresh page load gives a fresh engine with
   an empty `played` set.
10. Open the dev panel, set speed to 10×, and let it fire Dam Square,
    toward-the-palace, and Royal Palace as in step 6.
11. As soon as Royal Palace finishes speaking, tap **pause** — this stops
    the clock so the next step isn't a race against real time.
12. Use **jump to** on **Noordermarkt**. It should fire immediately even
    though Westerkerk has never been visited or played. This is the actual
    skip-ahead check: the engine allows jumping up to 2 stops past wherever
    it last fired (config `lookahead: 2`), provided the destination itself
    hasn't already played. Note why the walk-to-Royal-Palace prefix in
    step 10 is necessary and not incidental: jumping to Noordermarkt from a
    standing start (nothing fired yet) would *not* work — Noordermarkt is
    outside the lookahead window until the cursor has advanced past Royal
    Palace.
13. Tap **resume**. Westerkerk should not speak — it was skipped over, not
    queued to play later.

## GPS permission denial and recovery (Task 7 behaviour)

1. `npm run dev` (no `?sim=1` — this exercises real `BrowserLocation`)
2. Open the app and tap **Start the walk**
3. When the browser prompts for location permission, **deny** it
4. Confirm a red banner appears at the top of the screen (`role="alert"`)
   with a message — the app must not fail silently or hang
5. Using the browser's site-settings UI, change the permission back to
   "Allow" for this origin
6. Trigger a fresh permission check (reload and start again, or use the
   browser's "reload to apply" prompt if offered)
7. Confirm the red banner clears once a fix is successfully obtained — it
   must not remain stuck on screen after the underlying problem is fixed

## Real GPS on a phone

1. `npm run dev -- --host` and note the LAN address
2. Serve over HTTPS (geolocation requires a secure context) — `npx vite --https`
   or a tunnel such as `npx localtunnel --port 5173`
3. Open on the phone, tap **Start the walk**, grant location permission
4. Confirm the red dot tracks you and the map follows
5. Confirm the screen does not sleep while the tour is running
6. Walk to a stop and confirm narration fires within ~2 fixes of arrival

## Known limitations (spec §2)

- Locking the screen or backgrounding the tab suspends GPS. The tour will
  resume when you return, but will not have triggered while away.
- This is a platform limit, not a bug. The fix is the Capacitor shell.
- `manifest.icons` is currently empty (see `vite.config.ts`'s `VitePWA`
  config). Without any icons the browser will not treat the app as
  installable to the home screen — it's a PWA shell in place, not yet a
  fully installable one. Real icon assets are needed to close this out.
