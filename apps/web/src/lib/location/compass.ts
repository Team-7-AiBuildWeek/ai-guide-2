/**
 * The device compass, as a heading in degrees clockwise from north.
 *
 * This is what points the map's view cone the way the walker is FACING —
 * GPS course (Fix.headingDeg) only knows the direction they are MOVING, and
 * reads null the moment they stand still, which on a walking tour is exactly
 * when they are looking around and the cone matters most.
 *
 * Two platform dialects, both handled here so nothing else needs to know:
 *  - iOS reports `webkitCompassHeading`, already clockwise-from-north.
 *  - Android reports `alpha` counter-clockwise from north on the
 *    `deviceorientationabsolute` event (plain `deviceorientation` there is
 *    relative to whatever way the phone happened to point at page load —
 *    useless as a compass), so it converts as 360 - alpha.
 *
 * iOS 13+ additionally gates the event behind a permission prompt that can
 * only be requested from a user gesture; `requestCompassPermission()` exists
 * to be called inside the Start button's click handler.
 */

export type HeadingListener = (headingDeg: number) => void;

interface OrientationEventWithCompass extends DeviceOrientationEvent {
  /** iOS only. Degrees clockwise from north. */
  webkitCompassHeading?: number;
}

interface OrientationEventConstructorWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/**
 * Asks iOS for compass access. Must run inside a user-gesture handler.
 * Everywhere else (Android, desktop) there is nothing to ask and it resolves
 * granted. A denial is a normal outcome, not an error: the map falls back to
 * GPS course.
 */
export async function requestCompassPermission(): Promise<'granted' | 'denied'> {
  const ctor = DeviceOrientationEvent as unknown as OrientationEventConstructorWithPermission;
  if (typeof ctor.requestPermission !== 'function') return 'granted';
  try {
    return await ctor.requestPermission();
  } catch {
    // iOS throws (rather than resolving 'denied') when called outside a
    // gesture. Same consequence either way: no compass, GPS fallback.
    return 'denied';
  }
}

export class CompassWatcher {
  private listener: HeadingListener | null = null;
  private readonly onEvent = (event: DeviceOrientationEvent) => {
    const heading = compassHeadingFrom(event);
    if (heading !== null) this.listener?.(heading);
  };

  start(listener: HeadingListener): void {
    this.stop();
    this.listener = listener;
    // Register both: browsers that fire `deviceorientationabsolute` (Chrome
    // on Android) use it, and `compassHeadingFrom` ignores the non-absolute
    // event there, so double registration cannot double-report.
    window.addEventListener('deviceorientationabsolute', this.onEvent as EventListener);
    window.addEventListener('deviceorientation', this.onEvent as EventListener);
  }

  stop(): void {
    window.removeEventListener('deviceorientationabsolute', this.onEvent as EventListener);
    window.removeEventListener('deviceorientation', this.onEvent as EventListener);
    this.listener = null;
  }
}

/**
 * Degrees clockwise from north, or null when this event carries no usable
 * compass reading. Exported for tests — the event dialects are exactly the
 * kind of thing that silently breaks on one platform only.
 */
export function compassHeadingFrom(event: DeviceOrientationEvent): number | null {
  const webkit = (event as OrientationEventWithCompass).webkitCompassHeading;
  if (typeof webkit === 'number' && !Number.isNaN(webkit)) {
    return normalizeDeg(webkit);
  }
  // Without `absolute`, alpha is relative to the phone's orientation at page
  // load — treating it as a compass would draw a cone that is confidently,
  // consistently wrong, which is worse than no cone.
  if (event.absolute !== true || event.alpha === null) return null;
  return normalizeDeg(360 - event.alpha);
}

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Shortest-arc difference `b - a` in (-180, 180]. The camera uses this to
 * decide whether a heading change is worth rotating for: 350° -> 10° is a
 * 20° turn, not a 340° one.
 */
export function headingDeltaDeg(a: number, b: number): number {
  const raw = normalizeDeg(b - a);
  return raw > 180 ? raw - 360 : raw;
}
