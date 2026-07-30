export interface Fix {
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. Larger is worse. */
  accuracyM: number;
  /** Epoch milliseconds. */
  timestamp: number;
  /**
   * Direction of travel in degrees clockwise from true north, or null when
   * unknown. GPS course only exists while moving — a walker standing still
   * gets null, which is why the map's view cone prefers the device compass
   * and uses this as the fallback.
   */
  headingDeg?: number | null;
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
