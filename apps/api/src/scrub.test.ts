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
