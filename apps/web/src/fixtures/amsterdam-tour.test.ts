import { describe, it, expect } from 'vitest';
import { TourSchema } from '@ai-guide/shared';
import { amsterdamTour } from './amsterdam-tour';

describe('TourSchema', () => {
  it('parses the Amsterdam fixture cleanly', () => {
    const result = TourSchema.safeParse(amsterdamTour);
    expect(result.success).toBe(true);
  });
});
