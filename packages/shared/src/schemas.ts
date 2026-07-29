import { z } from 'zod';

export const LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'sk'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const GenerateRequestSchema = z.object({
  city: z.string().min(1),
  profileText: z.string().min(1).max(2000),
  language: z.enum(LANGUAGES),
  persona: z.string().max(500),
  budgetMin: z.number().int().min(20).max(180),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const PoiSchema = z.object({
  wikidataQid: z.string().regex(/^Q\d+$/),
  names: z.record(z.string(), z.string()),
  point: LatLngSchema,
  p31Types: z.array(z.string()),
  wikiEnTitle: z.string().nullable(),
  wikiLocalTitle: z.string().nullable(),
  summaryEn: z.string().nullable(),
  summaryLocal: z.string().nullable(),
  wheelchair: z.string().nullable(),
});
export type Poi = z.infer<typeof PoiSchema>;

export const CuratedStopSchema = z.object({
  wikidataQids: z.array(z.string().regex(/^Q\d+$/)).min(1),
  standingPoint: LatLngSchema,
  title: z.string().min(1),
  why: z.string().min(1),
  order: z.number().int().min(0),
});
export type CuratedStop = z.infer<typeof CuratedStopSchema>;

export const CurationOutputSchema = z.object({
  tourTitle: z.string().min(1),
  stops: z.array(CuratedStopSchema).min(8).max(12),
});
export type CurationOutput = z.infer<typeof CurationOutputSchema>;

export const NarrationSegmentSchema = z.object({
  order: z.number().int().min(0),
  kind: z.enum(['intro', 'stop', 'walk', 'outro']),
  title: z.string().min(1),
  script: z.string().min(1),
});

export const NarrationOutputSchema = z.object({
  segments: z.array(NarrationSegmentSchema).min(3),
});
export type NarrationOutput = z.infer<typeof NarrationOutputSchema>;

export const SegmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['intro', 'stop', 'walk', 'outro']),
  order: z.number(),
  title: z.string(),
  script: z.string(),
  audioUrl: z.string().nullable(),
  durationMs: z.number().nullable(),
  trigger: LatLngSchema.nullable(),
  triggerRadiusM: z.number(),
  poiIds: z.array(z.string()),
});

export const LineStringSchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(z.tuple([z.number(), z.number()])),
});

export const TourSchema = z.object({
  id: z.string(),
  city: z.string(),
  language: z.string(),
  persona: z.string(),
  title: z.string(),
  segments: z.array(SegmentSchema),
  routeGeoJson: LineStringSchema,
  estimatedDurationMin: z.number(),
});
