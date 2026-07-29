// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCassetteStore, InMemoryCassetteStore, cassetteFilename } from './store.ts';

const response = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"hello":"world"}',
};

describe('InMemoryCassetteStore', () => {
  it('round-trips a response', async () => {
    const store = new InMemoryCassetteStore();
    await store.put('GET https://x.test/a', response);
    expect(await store.get('GET https://x.test/a')).toEqual(response);
  });

  it('returns null for an unknown key', async () => {
    expect(await new InMemoryCassetteStore().get('GET https://x.test/nope')).toBeNull();
  });
});

describe('FileCassetteStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cassette-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a response through the filesystem', async () => {
    const store = new FileCassetteStore(dir);
    await store.put('GET https://x.test/a', response);
    expect(await store.get('GET https://x.test/a')).toEqual(response);
  });

  it('returns null for an unknown key', async () => {
    expect(await new FileCassetteStore(dir).get('GET https://x.test/nope')).toBeNull();
  });

  it('creates the directory if it does not exist', async () => {
    const nested = join(dir, 'deep', 'deeper');
    await new FileCassetteStore(nested).put('GET https://x.test/a', response);
    expect(await readdir(nested)).toHaveLength(1);
  });

  it('keeps separate keys in separate files', async () => {
    const store = new FileCassetteStore(dir);
    await store.put('GET https://x.test/a', response);
    await store.put('GET https://x.test/b', { ...response, body: '{"b":1}' });
    expect(await readdir(dir)).toHaveLength(2);
  });

  it('stores the original key inside the file so it is self-describing', async () => {
    const store = new FileCassetteStore(dir);
    const key = 'POST https://query.wikidata.org/sparql abc123';
    await store.put(key, response);

    const [file] = await readdir(dir);
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, file), 'utf8'),
    );
    expect(JSON.parse(raw).key).toBe(key);
  });
});

describe('cassetteFilename', () => {
  it('is readable enough to find by eye', () => {
    expect(cassetteFilename('POST https://query.wikidata.org/sparql')).toMatch(
      /^query-wikidata-org-sparql-[0-9a-f]{12}\.json$/,
    );
  });

  it('differs for different keys', () => {
    expect(cassetteFilename('GET https://x.test/a')).not.toBe(
      cassetteFilename('GET https://x.test/b'),
    );
  });

  it('is stable for the same key', () => {
    expect(cassetteFilename('GET https://x.test/a')).toBe(
      cassetteFilename('GET https://x.test/a'),
    );
  });
});
