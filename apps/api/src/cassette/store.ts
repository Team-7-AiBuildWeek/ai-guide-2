import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CassetteStore, RecordedResponse } from './types.ts';

export class InMemoryCassetteStore implements CassetteStore {
  private readonly entries = new Map<string, RecordedResponse>();

  async get(key: string): Promise<RecordedResponse | null> {
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: RecordedResponse): Promise<void> {
    this.entries.set(key, value);
  }
}

/**
 * Derives a filename that is both collision-free and findable by eye.
 *
 * The hash alone would be correct but unreadable, and someone debugging a
 * cassette miss needs to be able to spot the right file in a directory
 * listing without grepping every one of them.
 */
export function cassetteFilename(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);

  const urlMatch = /\bhttps?:\/\/([^\s?#]+)/.exec(key);
  const slug = (urlMatch?.[1] ?? 'request')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `${slug || 'request'}-${digest}.json`;
}

interface CassetteFile {
  /** The original request key, so a file on disk is self-describing. */
  key: string;
  response: RecordedResponse;
}

export class FileCassetteStore implements CassetteStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async get(key: string): Promise<RecordedResponse | null> {
    try {
      const raw = await readFile(join(this.dir, cassetteFilename(key)), 'utf8');
      return (JSON.parse(raw) as CassetteFile).response;
    } catch (err) {
      // A missing cassette is an ordinary outcome — the caller decides what it
      // means. Anything else (corrupt JSON, permissions) is a real problem and
      // must not be disguised as a miss.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(key: string, value: RecordedResponse): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file: CassetteFile = { key, response: value };
    await writeFile(
      join(this.dir, cassetteFilename(key)),
      `${JSON.stringify(file, null, 2)}\n`,
      'utf8',
    );
  }
}
