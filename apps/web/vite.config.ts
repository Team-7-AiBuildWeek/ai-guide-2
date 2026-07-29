import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  resolve: { preserveSymlinks: false },
  optimizeDeps: { exclude: ['@ai-guide/shared'] },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'City Tours',
        short_name: 'Tours',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [],
      },
      workbox: {
        // Default precache limit is 2 MiB; the main JS chunk (mapbox-gl +
        // zod, pulled in at runtime by tourStore.ts's TourSchema.parse,
        // + react/tailwind) now sits just over that. Raised rather than
        // code-split — this is a single-page prototype, not a place where
        // splitting pays for itself yet.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Narration MP3s, so a tour keeps talking where there is no signal —
        // routine in a dense old town, and the whole point of an audio guide.
        //
        // ANCHORED AT THE START, and that is not cosmetic. Workbox only
        // applies a RegExp urlPattern to a CROSS-ORIGIN request if the match
        // begins at position 0 of the URL — a deliberate guard against
        // accidentally caching third parties. The previous `/\.mp3$/` matched
        // the URL perfectly well in isolation and was silently ignored for
        // every Supabase request, so nothing was ever cached and the failure
        // looked like the audio element's Range requests rather than the
        // pattern. Verified empirically: a plain fetch() with no Range header
        // was not cached either.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/public\/.*\.mp3$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tour-audio',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              // Cross-origin responses are only cacheable when they are not
              // opaque. Supabase sends CORS headers so these are status 200;
              // 0 is allowed for the opaque case rather than silently
              // dropping every entry if that ever changes.
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
