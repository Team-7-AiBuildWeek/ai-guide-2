export interface CityConfig {
  slug: string;
  name: string;
  /** ISO 639-1 code of the city's dominant local Wikipedia edition, e.g. 'sk'. */
  localLanguage: string;
  centre: { lat: number; lng: number };
  radiusM: number;
}

export const BRATISLAVA: CityConfig = {
  slug: 'bratislava',
  name: 'Bratislava',
  localLanguage: 'sk',
  centre: { lat: 48.1436, lng: 17.1085 }, // Hlavné námestie
  radiusM: 1000,
};

/** Every city this prototype knows how to generate a tour for. */
export const CITIES: CityConfig[] = [BRATISLAVA];

/**
 * Resolves a `GenerateRequest.city` value (whatever a traveller typed, e.g.
 * "Bratislava") to its `CityConfig` — matching the slug or the display name,
 * case-insensitively. Returns `undefined` for anywhere this prototype
 * doesn't support, so the orchestrator can fail the job with a clear message
 * instead of discovering an empty city by accident.
 */
export function findCityConfig(cityNameOrSlug: string): CityConfig | undefined {
  const needle = cityNameOrSlug.trim().toLowerCase();
  return CITIES.find((city) => city.slug === needle || city.name.toLowerCase() === needle);
}
