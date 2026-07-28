# Manual testing

## Node version — read this first

This machine's default Node (20.17.0) cannot run the test suite: `npm test`
dies with `ERR_REQUIRE_ESM` somewhere inside jsdom's dependency chain. `npm
run build` still succeeds on 20.17.0 — a green build proves nothing about
whether the tests pass, so don't take it as a substitute for `npm test`.

`vite` and `jsdom` both require Node `^20.19.0 || >=22.12.0`. The repo pins
`25.2.1` in `.nvmrc` and in `package.json`'s `engines` field. Before running
any `npm` command in this repo, put the pinned Node first on `PATH`:

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
4. Open the `dev` panel, set speed to 10×
5. Expect, in order: Dam Square → toward the palace → Royal Palace →
   Westerkerk → Noordermarkt, each speaking on arrival
6. Tap **inject bad fix** — nothing should fire (the engine's accuracy gate
   discards it)
7. Tap a stop in the bottom list — it should play immediately, interrupting
   whatever is speaking
8. Use **jump to** to skip to Noordermarkt — it should fire without requiring
   the intermediate stops
9. **StrictMode check (open question, not an assumption):** on this very
   first dev-server load, before doing anything else, open the browser
   console and watch it as the map mounts. React StrictMode double-invokes
   effects in dev, and it is not yet confirmed whether a stale `load` handler
   from the first (discarded) `mapbox-gl` `Map` instance can fire against the
   second instance. Watch for either symptom:
   - a mapbox error to the effect of "already a source" / "already a layer", or
   - stop markers appearing twice (duplicated pins on the map, or duplicate
     entries reacting to clicks)
   Record whether either symptom appears. This is a real open question about
   effect cleanup ordering under StrictMode, not a formality — do not assume
   it's fine because the build is green.

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
