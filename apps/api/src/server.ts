import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { app } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDistDir = join(here, '..', '..', 'web', 'dist');

// One Fly app serves both: the API under /api/*, and the built web app for
// everything else. `apps/web/dist` doesn't exist until `npm run build` has
// been run there (never in local development against the dev server), so
// this is conditional rather than something that fails when it's missing.
if (existsSync(webDistDir)) {
  app.use('*', serveStatic({ root: webDistDir }));
}

const port = Number(process.env.PORT ?? 8080);

// Bind 0.0.0.0 explicitly. Node's own "no hostname given" default already
// listens on all interfaces, but a container that instead binds to
// localhost/127.0.0.1 looks perfectly healthy in its own logs while being
// unreachable from outside — Fly's health checks and, later, a phone on the
// same network need this to actually be true, not just true by accident.
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`ai-guide api listening on http://0.0.0.0:${info.port}`);
});
