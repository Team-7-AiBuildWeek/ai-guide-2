import { useEffect, useRef, useState } from 'react';
import type { Fix } from '../lib/location/types';
import { CompassWatcher, headingDeltaDeg } from '../lib/location/compass';

/**
 * The direction the walker is facing, in degrees clockwise from north, or
 * null while unknown.
 *
 * Compass first, GPS course as fallback: the compass knows where you are
 * LOOKING even while you stand still (which, on a walking tour, is most of
 * the time narration plays), while GPS course only exists in motion. The
 * fallback matters on iOS when the compass permission was declined — the
 * cone then at least points the way you last walked.
 *
 * Compass events arrive at up to device-sensor rate; re-rendering React for
 * every one would burn a phone battery drawing invisible 1° changes, so
 * updates below `MIN_CHANGE_DEG` are swallowed here rather than pushed to
 * state.
 */
const MIN_CHANGE_DEG = 3;

export function useHeading(compassActive: boolean, lastFix: Fix | null): number | null {
  const [compassHeading, setCompassHeading] = useState<number | null>(null);
  const lastReported = useRef<number | null>(null);

  useEffect(() => {
    if (!compassActive) return;
    const watcher = new CompassWatcher();
    watcher.start((heading) => {
      const prev = lastReported.current;
      if (prev !== null && Math.abs(headingDeltaDeg(prev, heading)) < MIN_CHANGE_DEG) return;
      lastReported.current = heading;
      setCompassHeading(heading);
    });
    return () => watcher.stop();
  }, [compassActive]);

  return compassHeading ?? lastFix?.headingDeg ?? null;
}
