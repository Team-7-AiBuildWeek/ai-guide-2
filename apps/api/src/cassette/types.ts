/**
 * Recording modes for external HTTP calls.
 *
 * The pipeline talks to Wikidata, Wikipedia, Overpass, Mapbox and the
 * Anthropic API. Anthropic calls cost real money — roughly $0.46 for a full
 * tour generation — so ordinary development runs entirely from recordings.
 */
export type CassetteMode = 'replay' | 'record' | 'live';

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface CassetteStore {
  get(key: string): Promise<RecordedResponse | null>;
  put(key: string, value: RecordedResponse): Promise<void>;
}
