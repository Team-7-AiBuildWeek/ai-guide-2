import type { Segment, Tour } from '@ai-guide/shared';
import type { Fix } from '../location/types';
import { haversineM, distanceToLineStringM } from '@ai-guide/shared';

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
  /** Consecutive in-radius fixes per segment id. Segments that fall out of
   * range are deleted, not decremented — hysteresis means *consecutive*. */
  private hits = new Map<string, number>();
  private played = new Set<string>();

  private offRouteSince: number | null = null;
  private offRouteAnnounced = false;
  /** Timestamp of the last fix that reached off-route evaluation (i.e. was
   * not discarded for poor accuracy). Used to detect long gaps between
   * observations â€” see evaluateOffRoute. */
  private lastValidFixAt: number | null = null;

  constructor(tour: Tour, config: Partial<EngineConfig> = {}) {
    this.tour = tour;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get playedIds(): ReadonlySet<string> {
    // A copy, not the live set â€” the `ReadonlySet` type only stops callers
    // from calling mutating methods through this reference; it does nothing
    // to stop them holding onto it and reading it later, at which point it
    // would have silently changed underneath them since it's the same
    // mutable object `onFix`/`selectManually` keep writing to.
    return new Set(this.played);
  }

  onFix(fix: Fix): EngineEvent[] {
    // Urban canyons produce wildly inaccurate fixes. Acting on them causes
    // narration to fire streets away from the actual stop.
    if (fix.accuracyM > this.config.maxAccuracyM) return [];

    const events: EngineEvent[] = [];
    events.push(...this.evaluateOffRoute(fix));

    const candidates = this.findCandidates(fix);
    const inRange = new Set(candidates.map((c) => c.segment.id));

    // Anything no longer in range loses its streak entirely.
    for (const id of [...this.hits.keys()]) {
      if (!inRange.has(id)) this.hits.delete(id);
    }

    // Every in-range segment advances. Incrementing only the nearest is what
    // caused the original defect: GPS jitter flipping which of two co-located
    // stops is nearest reset both counters on every fix, so neither ever fired.
    for (const c of candidates) {
      this.hits.set(c.segment.id, (this.hits.get(c.segment.id) ?? 0) + 1);
    }

    // Tie-break on tour order, not distance.
    //
    // Distance looks like the natural choice, and it was the original one, but
    // it is only a proxy for "which segment is the walker at" — and the proxy
    // breaks in the two cases that actually arise. A walk cue sits a few tens
    // of metres from the stop it departs from, so their zones overlap and the
    // cue can be nearer while the stop has not played yet. Worse, a real
    // Bratislava route doubles back on itself: Mapbox's walking directions for
    // the last leg pass within 0.1 m of an earlier point on the same polyline,
    // where distance carries no information about progress whatsoever.
    //
    // Order does. The walker traverses the tour in order, so among segments
    // that have all cleared hysteresis, the earliest unplayed one is the one
    // they have reached. Skip-ahead is unaffected: the lookahead window still
    // bounds which segments are candidates at all, so standing at stop 6 with
    // 4 and 5 out of range still fires 6.
    const ready = candidates
      .filter((c) => (this.hits.get(c.segment.id) ?? 0) >= this.config.requiredHits)
      .sort((a, b) => a.index - b.index);

    const winner = ready[0];
    if (winner !== undefined) {
      this.played.add(winner.segment.id);
      // The cursor bounds the forward lookahead window; a fix on a segment
      // behind it (reached via skip-ahead, then backtracked to) must not
      // regress it and shrink that window.
      this.cursorIndex = Math.max(this.cursorIndex, winner.index + 1);
      this.hits.delete(winner.segment.id);
      events.push({ type: 'fire', segment: winner.segment });
    }

    return events;
  }

  /**
   * Play any segment on demand. This is the escape hatch that keeps the app
   * usable when GPS misbehaves â€” see spec Â§8.
   */
  selectManually(segmentId: string): Segment {
    const index = this.tour.segments.findIndex((s) => s.id === segmentId);
    if (index === -1) throw new Error(`Unknown segment id: ${segmentId}`);

    const segment = this.tour.segments[index];
    this.played.add(segment.id);
    if (index + 1 > this.cursorIndex) this.cursorIndex = index + 1;
    this.hits.clear();
    return segment;
  }

  /**
   * Finds every not-yet-played segment within the lookahead window whose
   * adapted radius contains this fix — not just the nearest. Two stops can
   * legitimately be in range at once (co-located stops with overlapping
   * accuracy-widened radii); `onFix` is responsible for advancing hysteresis
   * on all of them and picking the nearest only among those that are ready
   * to fire.
   *
   * Scans from the start rather than from the cursor: the cursor only caps
   * how far ahead a walker may skip, it is not a claim that everything
   * behind it has been heard. De-duplication is the `played` set's job â€”
   * scanning from the cursor would make segments passed over by a skip-ahead
   * permanently unreachable.
   */
  private findCandidates(fix: Fix): { segment: Segment; index: number; distanceM: number }[] {
    const end = Math.min(
      this.tour.segments.length,
      this.cursorIndex + this.config.lookahead + 1,
    );

    const found: { segment: Segment; index: number; distanceM: number }[] = [];

    for (let i = 0; i < end; i++) {
      const segment = this.tour.segments[i];
      if (segment.trigger === null) continue;
      if (this.played.has(segment.id)) continue;
      if (segment.kind === 'walk' && !this.precedingStopPlayed(i)) continue;

      const distanceM = haversineM(fix, segment.trigger);
      // Widen the radius to the reported accuracy: a 25 m radius is
      // unreachable when the device only knows position to within 45 m.
      const radiusM = Math.max(segment.triggerRadiusM, fix.accuracyM);
      if (distanceM > radiusM) continue;

      found.push({ segment, index: i, distanceM });
    }

    return found;
  }

  /**
   * A walk cue is only eligible once the stop it departs from has played.
   *
   * This is a structural dependency, not a geometric one. "Head left down the
   * alley" is meaningless until the walker has been told where they are, so a
   * cue firing before its own stop is always wrong regardless of distance.
   *
   * It has to be a rule rather than something the geometry guarantees: a cue
   * sits about a quarter of the way along its leg, which on a short leg is
   * only tens of metres from the stop, well inside both trigger radii. Which
   * of the two the walker's path approaches first is then an accident of how
   * the street curves — on the recorded Bratislava route the cue for the
   * Franciscan Church leg won that race.
   *
   * Skip-ahead is unaffected. A walker who skips the Franciscan Church
   * entirely never hears its departure cue, which is correct — they did not
   * walk that leg.
   */
  private precedingStopPlayed(walkIndex: number): boolean {
    for (let i = walkIndex - 1; i >= 0; i--) {
      const previous = this.tour.segments[i];
      if (previous.trigger === null) continue;
      return this.played.has(previous.id);
    }
    // No triggerable segment precedes it; nothing to wait for.
    return true;
  }

  private evaluateOffRoute(fix: Fix): EngineEvent[] {
    const distanceM = distanceToLineStringM(fix, this.tour.routeGeoJson);

    // How long since we last had any usable fix at all. Mobile browsers
    // suspend JavaScript when the phone backgrounds, and urban canyons can
    // drop every fix's accuracy below the usable threshold for minutes at a
    // stretch â€” a gap that long is not "sustained off-route observation",
    // regardless of why no valid fix arrived during it.
    const gapSincePreviousFixMs =
      this.lastValidFixAt === null ? null : fix.timestamp - this.lastValidFixAt;
    this.lastValidFixAt = fix.timestamp;

    if (distanceM <= this.config.offRouteThresholdM) {
      const wasAnnounced = this.offRouteAnnounced;
      this.offRouteSince = null;
      this.offRouteAnnounced = false;
      return wasAnnounced ? [{ type: 'backOnRoute' }] : [];
    }

    const gapTooLong =
      gapSincePreviousFixMs !== null && gapSincePreviousFixMs > this.config.offRouteDurationMs;

    if (this.offRouteSince === null || gapTooLong) {
      // Either the first off-route sample, or a fix that arrived after a
      // gap long enough that we can't claim continuous observation: treat
      // it as a fresh observation rather than the far end of one continuous
      // off-route stretch.
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
