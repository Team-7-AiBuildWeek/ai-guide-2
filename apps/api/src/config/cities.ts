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
