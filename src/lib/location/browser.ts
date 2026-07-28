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
        listener(fix);
      },
      (error) => {
        console.warn('Geolocation error', error.code, error.message);
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
