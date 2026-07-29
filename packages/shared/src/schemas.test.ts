import { describe, it, expect } from 'vitest';
import { CurationOutputSchema, GenerateRequestSchema } from './schemas';

const validRequest = {
  city: 'bratislava',
  profileText: 'brutalist architecture, and I hate crowds',
  language: 'sk',
  persona: 'a grumpy local historian',
  budgetMin: 60,
};

describe('GenerateRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(GenerateRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it('rejects a budget below the supported range', () => {
    const r = GenerateRequestSchema.safeParse({ ...validRequest, budgetMin: 5 });
    expect(r.success).toBe(false);
  });

  it('rejects an unsupported language', () => {
    const r = GenerateRequestSchema.safeParse({ ...validRequest, language: 'ja' });
    expect(r.success).toBe(false);
  });

  it('rejects empty profile text', () => {
    const r = GenerateRequestSchema.safeParse({ ...validRequest, profileText: '' });
    expect(r.success).toBe(false);
  });
});

describe('CurationOutputSchema', () => {
  it('rejects fewer than 8 stops', () => {
    expect(CurationOutputSchema.safeParse({ tourTitle: 'x', stops: [] }).success).toBe(false);
  });

  it('rejects a malformed Wikidata QID', () => {
    const r = CurationOutputSchema.safeParse({
      tourTitle: 'x',
      stops: Array.from({ length: 8 }, (_, i) => ({
        wikidataQids: ['not-a-qid'],
        standingPoint: { lat: 48.14, lng: 17.10 },
        title: 't', why: 'w', order: i,
      })),
    });
    expect(r.success).toBe(false);
  });
});
