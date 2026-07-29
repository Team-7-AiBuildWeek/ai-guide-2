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
        // Narration MP3s arrive in Plan 2; caching them makes tours work
        // without signal, which is common in dense old towns. No MP3s
        // exist yet in this plan, so this rule matches nothing today — it
        // is dormant configuration, not dead code, established now so
        // Plan 2 doesn't have to touch the PWA shell to get offline audio.
        runtimeCaching: [
          {
            urlPattern: /\.mp3$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tour-audio',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
});
