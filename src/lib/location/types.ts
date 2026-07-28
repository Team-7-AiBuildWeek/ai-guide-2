export interface Fix {
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. Larger is worse. */
  accuracyM: number;
  /** Epoch milliseconds. */
  timestamp: number;
}

export type FixListener = (fix: Fix) => void;

export interface LocationProvider {
  start(listener: FixListener): void;
  stop(): void;
}
