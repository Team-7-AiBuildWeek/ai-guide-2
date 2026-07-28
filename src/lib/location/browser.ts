import type { Fix, FixListener, LocationProvider } from './types';

/**
 * Real GPS via the Geolocation API.
 *
 * Only produces fixes while the page is foregrounded and visible — mobile
 * browsers suspend JavaScript when the screen locks. See spec §2; the fix for
 * that is a native shell, not a code change here.
 */
export class BrowserLocation implements LocationProvider {
  private watchId: number | null = null;

  /**
   * `onError`, if given, is called with a human-readable message whenever the
   * browser reports a geolocation failure (permission denied, no fix
   * available, timeout, ...), and called again with `null` as soon as a fix
   * arrives — a `POSITION_UNAVAILABLE` or timeout is frequently transient
   * (the user walks out from under an awning), and a UI that latches the
   * error message forever would tell the user the opposite of the truth.
   * This is deliberately not part of `LocationProvider` — `SimulatedLocation`
   * has no failure mode to report, and widening the shared interface for
   * this implementation's needs would be the wrong trade. Consumers that
   * care about GPS failures (i.e. the UI) pass a callback here instead.
   */
  private readonly onError?: (message: string | null) => void;

  constructor(onError?: (message: string | null) => void) {
    this.onError = onError;
  }

  start(listener: FixListener): void {
    this.stop();

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const fix: Fix = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          timestamp: position.timestamp,
        };
        this.onError?.(null);
        listener(fix);
      },
      (error) => {
        console.warn('Geolocation error', error.code, error.message);
        this.onError?.(
          error.code === 1 // GeolocationPositionError.PERMISSION_DENIED
            ? 'Location access was denied. Enable location for this site in your browser settings to continue the walk.'
            : 'Could not get a GPS fix. Move to an open area and try again.',
        );
      },
      {
        enableHighAccuracy: true,
        // A cached fix from two minutes ago is worse than no fix — it will
        // trigger narration for a stop the user has already walked past.
        maximumAge: 0,
        timeout: 15_000,
      },
    );
  }

  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}
