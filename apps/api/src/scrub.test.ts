import { describe, it, expect } from 'vitest';
import { scrubSecrets } from './scrub.ts';

describe('scrubSecrets', () => {
  it('redacts a Mapbox access_token in a URL', () => {
    const text =
      'Cassette miss: GET https://api.mapbox.com/directions/v5/mapbox/walking/17.1,48.1?geometries=geojson&access_token=pk.eyJ1IjoiZXhhbXBsZSJ9.abc123';
    const out = scrubSecrets(text);
    expect(out).not.toContain('pk.eyJ1IjoiZXhhbXBsZSJ9.abc123');
    expect(out).toContain('access_token=REDACTED');
  });

  it('keeps the rest of the message intact so the error is still useful', () => {
    const out = scrubSecrets('Cassette miss: GET https://x.test/a?access_token=secret123&b=2');
    expect(out).toContain('Cassette miss');
    expect(out).toContain('https://x.test/a');
    expect(out).toContain('b=2');
  });

  it('redacts several credential parameter names', () => {
    const out = scrubSecrets('?api_key=aaa&token=bbb&password=ccc&key=ddd');
    for (const secret of ['aaa', 'bbb', 'ccc', 'ddd']) {
      expect(out).not.toContain(secret);
    }
  });

  it('leaves text with no credentials untouched', () => {
    const text = 'Mapbox returned 422: Cannot find route between points 2 and 3.';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('handles several occurrences in one string', () => {
    const out = scrubSecrets('a?access_token=one then b?access_token=two');
    expect(out).not.toContain('one');
    expect(out).not.toContain('two');
    expect(out.match(/REDACTED/g)).toHaveLength(2);
  });
});

describe('scrubSecrets — bare tokens with no name= in front', () => {
  // Two credentials have escaped through error text in this project: a Mapbox
  // token via a cassette-miss URL, and a Google API key via a synthesis
  // warning. Both had `name=` in front. These cover the case where one does
  // not — a token quoted on its own in a message, body or stack frame.
  it('redacts a Google API key', () => {
    const out = scrubSecrets('failed with AIzaSyA6cm83prbIYSfHJmH2y3DLHubSR_Lub5M oh dear');
    expect(out).not.toContain('AIzaSyA6cm83prbIYSfHJmH2y3DLHubSR_Lub5M');
    expect(out).toContain('GOOGLE_API_KEY:REDACTED');
    expect(out).toContain('oh dear');
  });

  it('redacts an Anthropic key', () => {
    const out = scrubSecrets('Authorization: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA');
    expect(out).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('redacts a Supabase secret key', () => {
    const out = scrubSecrets('using sb_secret_AAAAAAAAAAAAAAAAAAAAAAAA now');
    expect(out).not.toContain('sb_secret_AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('redacts a Mapbox token, public or secret', () => {
    const pk = 'pk.eyJ1IjoiZXhhbXBsZSJ9.abc123DEF';
    expect(scrubSecrets(`token ${pk}`)).not.toContain(pk);
  });

  it('redacts a Postgres connection string, which carries the password', () => {
    const url = 'postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres';
    const out = scrubSecrets(`connect failed: ${url}`);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('connect failed');
  });

  it('leaves ordinary prose alone', () => {
    const text = 'Cannot find route between points 2 and 3.';
    expect(scrubSecrets(text)).toBe(text);
  });
});
