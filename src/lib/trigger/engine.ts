import type { Segment, Tour } from '../../types/tour';
import type { Fix } from '../location/types';
import { haversineM, distanceToLineStringM } from '../geo';

export type EngineEvent =
  | { type: 'fire'; segment: Segment }
  | { type: 'offRoute'; distanceM: number }
  | { type: 'backOnRoute' };

export interface EngineConfig {
  /** Fixes with worse accuracy than this are discarded entirely. */
  maxAccuracyM: number;
  /** Consecutive in-radius fixes required before firing. */
  requiredHits: number;
  /** How many segments past the cursor may fire, allowing skip-ahead. */
  lookahead: number;
  /** Distance from the route line that counts as off-route. */
  offRouteThresholdM: number;
  /** How long the user must stay off-route before we say anything. */
  offRouteDurationMs: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  maxAccuracyM: 50,
  requiredHits: 2,
  lookahead: 2,
  offRouteThresholdM: 60,
  offRouteDurationMs: 30_000,
};

/**
 * Decides which narration segment should play, given a stream of GPS fixes.
 *
 * Deliberately free of I/O and React: `onFix` is a pure-ish state transition
 * returning the events its caller should act on. That is what makes the whole
 * thing testable against a synthetic fix sequence (see SimulatedLocation).
 */
export class TriggerEngine {
  private readonly tour: Tour;
  private readonly config: EngineConfig;

  private cursorIndex = 0;
  private hits = 0;
  private hitSegmentId: string | null = null;
  private played = new Set<string>();

  private offRouteSince: number | null = null;
  private offRouteAnnounced = false;
  /** Timestamp of the last fix that reached off-route evaluation (i.e. was
   * not discarded for poor accuracy). Used to detect long gaps between
   * observations — see evaluateOffRoute. */
  private lastValidFixAt: number | null = null;
  /** True if at least one fix was discarded for poor accuracy since the last
   * valid fix. A gap that is merely sparse (no discards, just infrequent
   * polling) is still a continuous observation; a gap where fixes arrived
   * but were unusable is not. */
  private discardedSinceLastValidFix = false;

  constructor(tour: Tour, config: Partial<EngineConfig> = {}) {
    this.tour = tour;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get playedIds(): ReadonlySet<string> {
    return this.played;
  }

  onFix(fix: Fix): EngineEvent[] {
    // Urban canyons produce wildly inaccurate fixes. Acting on them causes
    // narration to fire streets away from the actual stop.
    if (fix.accuracyM > this.config.maxAccuracyM) {
      this.discardedSinceLastValidFix = true;
      return [];
    }

    const events: EngineEvent[] = [];
    events.push(...this.evaluateOffRoute(fix));

    const candidate = this.findCandidate(fix);

    if (candidate === null) {
      this.hits = 0;
      this.hitSegmentId = null;
      return events;
    }

    // Restart the count if the user moved to a different candidate.
    if (this.hitSegmentId !== candidate.segment.id) {
      this.hitSegmentId = candidate.segment.id;
      this.hits = 0;
    }

    this.hits += 1;

    if (this.hits >= this.config.requiredHits) {
      this.played.add(candidate.segment.id);
      // The cursor bounds the forward lookahead window; a fix on a segment
      // behind it (reached via skip-ahead, then backtracked to) must not
      // regress it and shrink that window.
      this.cursorIndex = Math.max(this.cursorIndex, candidate.index + 1);
      this.hits = 0;
      this.hitSegmentId = null;
      events.push({ type: 'fire', segment: candidate.segment });
    }

    return events;
  }

  /**
   * Play any segment on demand. This is the escape hatch that keeps the app
   * usable when GPS misbehaves — see spec §8.
   */
  selectManually(segmentId: string): Segment {
    const index = this.tour.segments.findIndex((s) => s.id === segmentId);
    if (index === -1) throw new Error(`Unknown segment id: ${segmentId}`);

    const segment = this.tour.segments[index];
    this.played.add(segment.id);
    if (index + 1 > this.cursorIndex) this.cursorIndex = index + 1;
    this.hits = 0;
    this.hitSegmentId = null;
    return segment;
  }

  /**
   * Finds the nearest not-yet-played segment within the lookahead window
   * whose adapted radius contains this fix.
   *
   * Scans from the start rather than from the cursor: the cursor only caps
   * how far ahead a walker may skip, it is not a claim that everything
   * behind it has been heard. De-duplication is the `played` set's job —
   * scanning from the cursor would make segments passed over by a skip-ahead
   * permanently unreachable.
   */
  private findCandidate(fix: Fix): { segment: Segment; index: number } | null {
    const end = Math.min(
      this.tour.segments.length,
      this.cursorIndex + this.config.lookahead + 1,
    );

    let best: { segment: Segment; index: number; distanceM: number } | null = null;

    for (let i = 0; i < end; i++) {
      const segment = this.tour.segments[i];
      if (segment.trigger === null) continue;
      if (this.played.has(segment.id)) continue;

      const distanceM = haversineM(fix, segment.trigger);
      // Widen the radius to the reported accuracy: a 25 m radius is
      // unreachable when the device only knows position to within 45 m.
      const radiusM = Math.max(segment.triggerRadiusM, fix.accuracyM);
      if (distanceM > radiusM) continue;

      if (best === null || distanceM < best.distanceM) {
        best = { segment, index: i, distanceM };
      }
    }

    return best === null ? null : { segment: best.segment, index: best.index };
  }

  private evaluateOffRoute(fix: Fix): EngineEvent[] {
    const distanceM = distanceToLineStringM(fix, this.tour.routeGeoJson);

    // How long since we last had a usable fix at all, and whether any fixes
    // arrived but were discarded for poor accuracy in between. Mobile
    // browsers suspend JavaScript when the phone backgrounds, and urban
    // canyons can drop every fix's accuracy below the usable threshold for
    // minutes at a stretch — neither is "sustained off-route observation",
    // even though a merely sparse (but unbroken) stream of valid fixes is.
    const gapSincePreviousFixMs =
      this.lastValidFixAt === null ? null : fix.timestamp - this.lastValidFixAt;
    const hadDiscardsDuringGap = this.discardedSinceLastValidFix;
    this.lastValidFixAt = fix.timestamp;
    this.discardedSinceLastValidFix = false;

    if (distanceM <= this.config.offRouteThresholdM) {
      const wasAnnounced = this.offRouteAnnounced;
      this.offRouteSince = null;
      this.offRouteAnnounced = false;
      return wasAnnounced ? [{ type: 'backOnRoute' }] : [];
    }

    const gapTooLong =
      hadDiscardsDuringGap &&
      gapSincePreviousFixMs !== null &&
      gapSincePreviousFixMs > this.config.offRouteDurationMs;

    if (this.offRouteSince === null || gapTooLong) {
      // Either the first off-route sample, or a fix that arrived after a
      // long gap during which fixes were being dropped for poor accuracy:
      // treat it as a fresh observation rather than the far end of one
      // continuous off-route stretch.
      this.offRouteSince = fix.timestamp;
      return [];
    }

    const elapsed = fix.timestamp - this.offRouteSince;
    if (elapsed >= this.config.offRouteDurationMs && !this.offRouteAnnounced) {
      this.offRouteAnnounced = true;
      return [{ type: 'offRoute', distanceM }];
    }

    return [];
  }
}
