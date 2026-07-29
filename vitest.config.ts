import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['apps/**/*.{test,spec}.{ts,tsx}', 'packages/**/*.{test,spec}.{ts,tsx}'],
    // Node 22+ ships its own global `localStorage`/`sessionStorage`
    // (gated behind `--localstorage-file`, which this repo doesn't set).
    // Left enabled, it shadows jsdom's own Storage implementation with a
    // stub missing methods like `clear()` — see apps/web/src/lib/api/client.ts,
    // the first consumer of localStorage in this codebase. Disabling it for
    // test workers lets jsdom's window.localStorage work as it does in a
    // real browser.
    execArgv: ['--no-experimental-webstorage'],
  },
});
