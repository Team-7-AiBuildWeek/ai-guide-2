import { describe, it, expect } from 'vitest';
import { resolveCassetteMode } from './mode.ts';

describe('resolveCassetteMode', () => {
  it('defaults to replay when unset', () => {
    expect(resolveCassetteMode(undefined)).toBe('replay');
    expect(resolveCassetteMode('')).toBe('replay');
  });

  it('accepts each valid mode', () => {
    expect(resolveCassetteMode('replay')).toBe('replay');
    expect(resolveCassetteMode('record')).toBe('record');
    expect(resolveCassetteMode('live')).toBe('live');
  });

  it('throws on a typo rather than silently choosing a default', () => {
    // Whichever default it fell back to would be wrong: replay would look
    // like a cassette-miss bug, and anything else would spend money.
    expect(() => resolveCassetteMode('recrod')).toThrow(/unrecognised/i);
  });

  it('names the offending value in the error', () => {
    expect(() => resolveCassetteMode('RECORD')).toThrow(/RECORD/);
  });
});
