import { useEffect, useState } from 'react';

/**
 * Holds a screen wake lock while `active` is true.
 *
 * Without this the screen sleeps mid-walk, JavaScript is suspended, and the
 * tour silently stops triggering. The lock is also re-acquired on visibility
 * change, because the browser releases it whenever the tab is hidden.
 */
export function useWakeLock(active: boolean): { supported: boolean; held: boolean } {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!supported || !active) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    // Guards against overlapping requests: a rapid hidden→visible→hidden→
    // visible flurry can fire the visibilitychange handler again before the
    // first `request('screen')` promise has settled. Without this check,
    // both calls would resolve to distinct sentinels and only the second
    // assignment to `sentinel` would survive — leaking the first, which then
    // never gets released.
    let acquiring = false;

    const acquire = async () => {
      if (acquiring || sentinel) return;
      acquiring = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        acquiring = false;
        if (cancelled) {
          void s.release();
          return;
        }
        sentinel = s;
        setHeld(true);
        sentinel.addEventListener('release', () => {
          sentinel = null;
          setHeld(false);
        });
      } catch {
        acquiring = false;
        setHeld(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
      sentinel = null;
      setHeld(false);
    };
  }, [active, supported]);

  return { supported, held };
}
