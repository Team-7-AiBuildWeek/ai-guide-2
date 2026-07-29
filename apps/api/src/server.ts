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

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ai-guide api listening on http://localhost:${info.port}`);
});
