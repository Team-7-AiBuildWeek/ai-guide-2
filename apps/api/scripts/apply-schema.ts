// Applies apps/api/src/db/schema.sql to the database at DATABASE_URL.
//
// Every statement in schema.sql is `if not exists` (or `on ... do update` /
// index guards), so this script is safe to run more than once — task 9
// verifies that by running it twice in a row.
//
//   $env:PATH = "C:\Users\palo\AppData\Local\nvm\v25.2.1;" + $env:PATH
//   node --experimental-strip-types apps/api/scripts/apply-schema.ts
//
// DATABASE_URL (which embeds the database password) is loaded from
// process.env, falling back to .env.local the same way
// scripts/record-routing.ts does. It is never printed, logged, or included
// in any error message this script produces.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/**
 * Loads KEY=VALUE pairs from `.env.local` into `process.env`, without ever
 * printing a value. Existing environment variables take precedence — this
 * only fills in gaps, the same way a shell-exported var normally would.
 */
async function loadEnvLocal(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.env.local'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  await loadEnvLocal();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (checked process.env and .env.local).');
  }

  const schemaPath = join(here, '..', 'src', 'db', 'schema.sql');
  const sql = await readFile(schemaPath, 'utf8');

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await pool.query(sql);
    console.log('schema.sql applied successfully.');
  } catch (err) {
    // Never let the connection string leak into a printed error — pg
    // errors don't normally embed it, but only ever surface `.message`,
    // never the raw error object or the Pool config, just in case.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`apply-schema failed: ${message}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
