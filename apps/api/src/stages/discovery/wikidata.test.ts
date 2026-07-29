// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRATISLAVA } from '../../config/cities.ts';
import { FileCassetteStore, cassetteFetch } from '../../cassette/index.ts';
import { buildDiscoveryQuery, fetchWikidataCandidates } from './wikidata.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cassetteDir = join(here, '..', '..', '..', 'cassettes');

function replayFetch(): typeof fetch {
  const store = new FileCassetteStore(cassetteDir);
  const unusedLive: typeof fetch = async () => {
    throw new Error('replay must never call through to a live fetch');
  };
  return cassetteFetch('replay', store, unusedLive);
}

describe('buildDiscoveryQuery', () => {
  it('does not add an ORDER BY — a validated run 502ed on a query that differed only by this clause', () => {
    expect(buildDiscoveryQuery(BRATISLAVA)).not.toMatch(/ORDER BY/i);
  });

  it("interpolates the city's centre point as lng-then-lat, matching the geo:wktLiteral convention", () => {
    const query = buildDiscoveryQuery(BRATISLAVA);
    expect(query).toContain('Point(17.1085 48.1436)');
  });

  it("interpolates the radius in kilometres and the city's local language", () => {
    const query = buildDiscoveryQuery(BRATISLAVA);
    expect(query).toContain('wikibase:radius "1"');
    expect(query).toContain('https://sk.wikipedia.org/');
    expect(query).toContain('wikibase:language "en,sk"');
  });
});

describe('fetchWikidataCandidates (replay)', () => {
  it('deduplicates items that carry two P625 coordinate statements', async () => {
    const candidates = await fetchWikidataCandidates(BRATISLAVA, { fetch: replayFetch() });
    const qids = candidates.map((c) => c.qid);
    expect(new Set(qids).size).toBe(qids.length);
    // Grassalkovich Palace is the documented duplicate in the recorded data.
    expect(qids.filter((q) => q === 'Q568640')).toHaveLength(1);
  });

  it('sorts by sitelinks descending and caps at 150', async () => {
    const candidates = await fetchWikidataCandidates(BRATISLAVA, { fetch: replayFetch() });
    expect(candidates.length).toBeLessThanOrEqual(150);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1].sitelinks).toBeGreaterThanOrEqual(candidates[i].sitelinks);
    }
    expect(candidates[0].qid).toBe('Q593311'); // Bratislava Castle — most sitelinks
  });

  it('includes the landmarks a guidebook would', async () => {
    const candidates = await fetchWikidataCandidates(BRATISLAVA, { fetch: replayFetch() });
    const qids = candidates.map((c) => c.qid);
    expect(qids).toContain('Q593311'); // Bratislava Castle
    expect(qids).toContain('Q239560'); // St Martin's Cathedral
    expect(qids).toContain('Q1717975'); // Michael's Gate
  });

  it('excludes geo-tagged things that are not places', async () => {
    const candidates = await fetchWikidataCandidates(BRATISLAVA, { fetch: replayFetch() });
    const labels = candidates.map((c) => c.label);
    expect(labels).not.toContain('Bratislava Region');
    expect(labels).not.toContain('Pozsony County');
  });
});
