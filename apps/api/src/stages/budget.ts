import { DWELL_SECONDS, NOMINAL_STOP_SCRIPT_CHARS, speakingSeconds } from './routing/index.ts';

/**
 * Mapbox's walking profile moves at roughly 1.4 m/s. Used only for planning —
 * the real per-leg durations come back from Directions.
 */
export const WALKING_SPEED_M_PER_MIN = 84;

/** Planning-time dwell per stop, in minutes. Mirrors what routing charges. */
export function dwellMinutesPerStop(): number {
  return (DWELL_SECONDS + speakingSeconds('x'.repeat(NOMINAL_STOP_SCRIPT_CHARS))) / 60;
}

/**
 * How far the traveller can actually walk inside their time budget, once
 * standing-and-listening time is deducted.
 *
 * This exists because curation was given a *time* budget and nothing else,
 * and time is not a quantity it can evaluate: it sees coordinates, not a
 * route. Asked for 60 minutes it produced a 5.2 km, 78-minute walk — over by
 * 44% — and every such overshoot costs a second full curation call through
 * the re-curation loop. Handing it a distance in metres gives it something it
 * can check against the coordinates it is choosing from.
 */
export function walkingBudgetM(budgetMin: number, stopCount: number): number {
  const dwellMin = stopCount * dwellMinutesPerStop();
  const walkMin = Math.max(0, budgetMin - dwellMin);
  return Math.round(walkMin * WALKING_SPEED_M_PER_MIN);
}

/**
 * The straight-line distance through the stops in order — a strict lower
 * bound on how far the walk can possibly be, since streets never shorten the
 * path between two points.
 *
 * Cheap enough to check before paying for routing, and unambiguous: if even
 * the straight line busts the allowance, the real route certainly does.
 */
export function straightLinePathM(
  points: { lat: number; lng: number }[],
  distance: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number,
): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}
