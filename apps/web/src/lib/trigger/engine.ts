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

  /**
   * A walk cue waiting for the walker to actually leave the stop it departs
   * from. See `evaluateDeparture`.
   */
  private pendingDeparture: { walkIndex: number; fromStop: Segment } | null = null;

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
    events.push(...this.evaluateDeparture(fix));

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
      this.armDeparture(winner.index);
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

    // A manually played stop arms its departure cue just as a triggered one
    // does — tapping a stop you are standing at should still cue you out of
    // it. And if the tapped segment IS the pending cue, it has now been heard,
    // so stop waiting for it.
    if (this.pendingDeparture?.walkIndex === index) this.pendingDeparture = null;
    this.armDeparture(index);

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
      // Walk cues are not proximity-triggered at all — see `evaluateDeparture`.
      if (segment.kind === 'walk') continue;

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
   * Arms the walk cue that follows a stop, so it can fire on departure.
   *
   * Called whenever a segment fires. Only a `stop` immediately followed by a
   * `walk` arms anything.
   */
  private armDeparture(firedIndex: number): void {
    const fired = this.tour.segments[firedIndex];
    if (fired.kind !== 'stop') return;

    const next = this.tour.segments[firedIndex + 1];
    if (next === undefined || next.kind !== 'walk') return;
    if (this.played.has(next.id)) return;

    this.pendingDeparture = { walkIndex: firedIndex + 1, fromStop: fired };
  }

  /**
   * Fires a walk cue when the walker leaves the stop it departs from.
   *
   * Walk cues are NOT proximity-triggered, and the reason is worth keeping:
   * they used to be, placed a quarter of the way along their leg, and that
   * design cannot be made correct. A cue point sits tens of metres from its
   * own stop, so their zones overlap; and on a route that crosses itself — the
   * real Bratislava tour passes within one metre of its own earlier path
   * twice — a cue's coordinate can be nearer to a later part of the walk than
   * to the leg it belongs to. Three separate fixes (order tie-break, waiting
   * for the departing stop, monotonic projection) each improved matters and
   * none closed it, because the premise was wrong: proximity was standing in
   * for progress, and on a self-intersecting route it is not.
   *
   * Departure is the honest trigger. "Head left down the alley" belongs to the
   * moment you leave, which is a thing the engine can observe directly: the
   * walker was inside the stop's radius, and now is not.
   *
   * A cue for a stop that was skipped never arms, which is correct — that leg
   * was not walked.
   */
  private evaluateDeparture(fix: Fix): EngineEvent[] {
    const pending = this.pendingDeparture;
    if (pending === null) return [];

    const stopPoint = pending.fromStop.trigger;
    if (stopPoint === null) {
      this.pendingDeparture = null;
      return [];
    }

    const distanceM = haversineM(fix, stopPoint);
    // Same accuracy widening the stop itself uses, so "left the radius" means
    // the same thing on both sides and a noisy fix cannot bounce the walker
    // out of a stop they are still standing in.
    const radiusM = Math.max(pending.fromStop.triggerRadiusM, fix.accuracyM);
    if (distanceM <= radiusM) return [];

    const walk = this.tour.segments[pending.walkIndex];
    this.pendingDeparture = null;
    if (this.played.has(walk.id)) return [];

    this.played.add(walk.id);
    this.cursorIndex = Math.max(this.cursorIndex, pending.walkIndex + 1);
    return [{ type: 'fire', segment: walk }];
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
