export interface LatLng {
  lat: number;
  lng: number;
}

/** GeoJSON LineString — note coordinates are [lng, lat] tuples. */
export interface LineString {
  type: 'LineString';
  coordinates: [number, number][];
}

export type SegmentKind = 'intro' | 'stop' | 'walk' | 'outro';

export interface Segment {
  id: string;
  kind: SegmentKind;
  /** Playback order within the tour, ascending from 0. */
  order: number;
  title: string;
  script: string;
  /** null in this plan — narration is spoken by speechSynthesis. */
  audioUrl: string | null;
  durationMs: number | null;
  /** null for intro and outro, which are not location-triggered. */
  trigger: LatLng | null;
  /** Base radius; the engine widens this to match GPS accuracy at runtime. */
  triggerRadiusM: number;
  poiId: string | null;
}

export interface Tour {
  id: string;
  city: string;
  /** BCP-47 tag, e.g. 'en', 'nl'. */
  language: string;
  persona: string;
  title: string;
  segments: Segment[];
  routeGeoJson: LineString;
  estimatedDurationMin: number;
}
