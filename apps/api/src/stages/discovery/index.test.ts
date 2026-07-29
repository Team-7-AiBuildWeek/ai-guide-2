// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRATISLAVA } from '../../config/cities.ts';
import { FileCassetteStore, cassetteFetch } from '../../cassette/index.ts';
import { discover } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', '..', '..', 'cassettes');

function replayFetch(): typeof fetch {
  const store = new FileCassetteStore(cassetteDir);
  const unusedLive: typeof fetch = async () => {
    throw new Error('replay must never call through to a live fetch');
  };
  return cassetteFetch('replay', store, unusedLive);
}

describe('discover', () => {
  it('excludes geo-tagged things that are not places', async () => {
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });
    const names = pois.map((p) => p.names.en ?? '');
    expect(names).not.toContain('Bratislava Region');
    expect(names).not.toContain('Pozsony County');
  });

  it('includes the landmarks a guidebook would', async () => {
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });
    const qids = pois.map((p) => p.wikidataQid);
    expect(qids).toContain('Q593311'); // Bratislava Castle
    expect(qids).toContain('Q239560'); // St Martin's Cathedral
    expect(qids).toContain('Q1717975'); // Michael's Gate
  });

  it('deduplicates items that carry two coordinate statements', async () => {
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });
    const qids = pois.map((p) => p.wikidataQid);
    expect(new Set(qids).size).toBe(qids.length);
    // Grassalkovich Palace is the known duplicate in the recorded data.
    expect(qids.filter((q) => q === 'Q568640')).toHaveLength(1);
  });

  it('caps the candidate set and orders it by notability', async () => {
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });
    expect(pois.length).toBeLessThanOrEqual(150);
    expect(pois[0].wikidataQid).toBe('Q593311'); // most sitelinks
  });

  it('produces Poi records with every field the shared schema requires', async () => {
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });
    expect(pois.length).toBeGreaterThan(0);
    const castle = pois.find((p) => p.wikidataQid === 'Q593311');
    expect(castle).toBeDefined();
    expect(castle?.point.lat).toBeCloseTo(48.14, 1);
    expect(castle?.point.lng).toBeCloseTo(17.1, 1);
    expect(castle?.wikiEnTitle).toBeTruthy();
    expect(castle?.summaryEn).toBeTruthy();
    expect(Array.isArray(castle?.p31Types)).toBe(true);
  });

  it('populates p31Types with the kind of place, not just an empty array', async () => {
    // `Array.isArray([])` is true, so the assertion above passed for a while
    // against a field that was empty for every single POI. Curation matches a
    // traveller's interests against these, so empty is not a harmless default.
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });

    expect(pois.filter((p) => p.p31Types.length > 0).length).toBeGreaterThan(pois.length / 2);

    const typesOf = (qid: string) => pois.find((p) => p.wikidataQid === qid)?.p31Types ?? [];
    expect(typesOf('Q593311')).toContain('castle');
    expect(typesOf('Q239560')).toContain('cathedral');
    expect(typesOf('Q1717975')).toContain('city gate');
    expect(typesOf('Q4178866')).toContain('fountain');
  });

  it('never leaks an unresolved QID into p31Types', async () => {
    // Wikidata's label service returns the bare QID when it has no label in
    // the requested languages. "Q12345" is not a kind of place and must not
    // reach the curation prompt as though it were.
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });
    const all = pois.flatMap((p) => p.p31Types);
    expect(all.filter((t) => /^Q\d+$/.test(t))).toEqual([]);
  });

  it('attaches null, not a throw, for POIs Overpass has no wheelchair tag for', async () => {
    const pois = await discover(BRATISLAVA, { fetch: replayFetch() });
    const withTag = pois.filter((p) => p.wheelchair !== null);
    const withoutTag = pois.filter((p) => p.wheelchair === null);
    // The recorded run found accessibility tags for only a handful of POIs —
    // the rest must be null, not missing or throwing.
    expect(withoutTag.length).toBeGreaterThan(0);
    expect(withTag.length).toBeGreaterThan(0);
  });
});
