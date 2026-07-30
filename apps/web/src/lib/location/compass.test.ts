import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CompassWatcher,
  compassHeadingFrom,
  headingDeltaDeg,
  normalizeDeg,
  requestCompassPermission,
} from './compass';

function orientationEvent(init: {
  alpha?: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
}): DeviceOrientationEvent {
  // jsdom's DeviceOrientationEvent constructor ignores `absolute` on some
  // versions, so build a plain object with the same shape instead.
  return {
    alpha: init.alpha ?? null,
    beta: null,
    gamma: null,
    absolute: init.absolute ?? false,
    webkitCompassHeading: init.webkitCompassHeading,
  } as unknown as DeviceOrientationEvent;
}

describe('compassHeadingFrom', () => {
  it('prefers the iOS webkitCompassHeading, which is already clockwise', () => {
    expect(compassHeadingFrom(orientationEvent({ webkitCompassHeading: 90 }))).toBe(90);
  });

  it('converts Android absolute alpha from counter-clockwise', () => {
    // alpha 90 (device rotated 90° CCW from north) = compass heading 270.
    expect(compassHeadingFrom(orientationEvent({ alpha: 90, absolute: true }))).toBe(270);
  });

  it('rejects non-absolute alpha rather than reporting a wrong heading', () => {
    // Relative alpha is measured from wherever the phone pointed at page
    // load. A cone drawn from it would be confidently wrong.
    expect(compassHeadingFrom(orientationEvent({ alpha: 90, absolute: false }))).toBeNull();
  });

  it('returns null when the event carries nothing', () => {
    expect(compassHeadingFrom(orientationEvent({ alpha: null, absolute: true }))).toBeNull();
  });

  it('normalizes alpha 0 to heading 0, not 360', () => {
    expect(compassHeadingFrom(orientationEvent({ alpha: 0, absolute: true }))).toBe(0);
  });
});

describe('normalizeDeg', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(725)).toBe(5);
  });
});

describe('headingDeltaDeg', () => {
  it('takes the short way around north', () => {
    expect(headingDeltaDeg(350, 10)).toBe(20);
    expect(headingDeltaDeg(10, 350)).toBe(-20);
  });

  it('is zero for equal headings', () => {
    expect(headingDeltaDeg(123, 123)).toBe(0);
  });
});

describe('requestCompassPermission', () => {
  const original = (DeviceOrientationEvent as unknown as { requestPermission?: unknown })
    .requestPermission;

  afterEach(() => {
    (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission =
      original;
  });

  it('resolves granted where there is no permission gate (Android, desktop)', async () => {
    (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission =
      undefined;
    await expect(requestCompassPermission()).resolves.toBe('granted');
  });

  it('passes through an iOS-style prompt result', async () => {
    (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission =
      vi.fn(async () => 'denied' as const);
    await expect(requestCompassPermission()).resolves.toBe('denied');
  });

  it('treats a throw (called outside a gesture) as denied, not a crash', async () => {
    (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission =
      vi.fn(async () => {
        throw new Error('gesture required');
      });
    await expect(requestCompassPermission()).resolves.toBe('denied');
  });
});

describe('CompassWatcher', () => {
  it('reports headings from orientation events and stops cleanly', () => {
    const watcher = new CompassWatcher();
    const seen: number[] = [];
    watcher.start((h) => seen.push(h));

    window.dispatchEvent(
      Object.assign(new Event('deviceorientation'), {
        alpha: 90,
        absolute: true,
      }),
    );
    expect(seen).toEqual([270]);

    watcher.stop();
    window.dispatchEvent(
      Object.assign(new Event('deviceorientation'), { alpha: 180, absolute: true }),
    );
    expect(seen).toEqual([270]);
  });

  it('re-starting replaces the listener instead of double-registering', () => {
    const watcher = new CompassWatcher();
    const first: number[] = [];
    const second: number[] = [];
    watcher.start((h) => first.push(h));
    watcher.start((h) => second.push(h));

    window.dispatchEvent(
      Object.assign(new Event('deviceorientation'), { alpha: 90, absolute: true }),
    );
    expect(first).toEqual([]);
    expect(second).toEqual([270]);
    watcher.stop();
  });
});
