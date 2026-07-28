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
  /**
   * Begins delivering fixes to `listener`.
   *
   * Calling `start()` while already started must not double-register —
   * implementations are required to stop any existing subscription first
   * (as if `stop()` had been called) before starting the new one. A caller
   * should never end up with two live subscriptions, e.g. two timers or two
   * `watchPosition` calls, delivering fixes to two different listeners.
   */
  start(listener: FixListener): void;
  stop(): void;
}
