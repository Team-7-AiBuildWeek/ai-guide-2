import type { CuratedStop, GenerateRequest, NarrationOutput, Segment, Tour } from '@ai-guide/shared';
import { DWELL_SECONDS, speakingSeconds, type RouteResult } from '../routing/index.ts';

/**
 * Recomputes the tour's estimated duration from the ACTUAL scripts, not the
 * nominal placeholder routing used before scripts existed (see routing's
 * `NOMINAL_SPEAKING_ALLOWANCE_S`). Walk-cue speaking time is not added on
 * top of the leg's walking duration — it is heard *while* walking, whereas a
 * stop script requires the traveller to stand still for it, which is why
 * only `stop` scripts add to `DWELL_SECONDS` per stop.
 */
function computeEstimatedDurationMin(route: RouteResult, stopCount: number, narration: NarrationOutput): number {
  const totalLegDurationS = route.legs.reduce((sum, leg) => sum + leg.durationS, 0);

  const totalDwellS = narration.segments
    .filter((seg) => seg.kind === 'stop')
    .reduce((sum, seg) => sum + DWELL_SECONDS + speakingSeconds(seg.script), 0);

  // Sanity: one dwell entry per stop, regardless of what the model called
  // its segments — a mismatch here means validate() in index.ts let a
  // malformed script through.
  if (narration.segments.filter((seg) => seg.kind === 'stop').length !== stopCount) {
    throw new Error(
      `assembleTour: expected ${stopCount} "stop" segments in the narration output, found ${
        narration.segments.filter((seg) => seg.kind === 'stop').length
      }.`,
    );
  }

  return (totalLegDurationS + totalDwellS) / 60;
}

/**
 * Assembles the final `Tour` the existing GPS-triggered player consumes —
 * the seam between this generation pipeline and the app. Match
 * `packages/shared/src/tour.ts` exactly: getting a field wrong here is
 * invisible to every other test in this pipeline and breaks the app.
 */
export function assembleTour(args: {
  tourId: string;
  tourTitle: string;
  city: string;
  request: GenerateRequest;
  stops: CuratedStop[];
  route: RouteResult;
  narration: NarrationOutput;
}): Tour {
  const { tourId, tourTitle, city, request, stops, route, narration } = args;

  const byOrder = [...stops].sort((a, b) => a.order - b.order);
  const narrationByOrder = [...narration.segments].sort((a, b) => a.order - b.order);

  const expectedSegmentCount = 2 * byOrder.length + 1;
  if (narrationByOrder.length !== expectedSegmentCount) {
    throw new Error(
      `assembleTour: expected ${expectedSegmentCount} narration segments for ${byOrder.length} stops (intro, stop, walk, ..., stop, outro), got ${narrationByOrder.length}.`,
    );
  }

  // Index into `byOrder` / `route.triggerRadiiM` of the NEXT stop still to
  // be consumed. Walking the narration sequence in order and advancing this
  // alongside it is what lets a `walk` segment look back at "the stop it
  // just departed" without re-deriving position from the kind sequence.
  let nextStopIndex = 0;

  const segments: Segment[] = narrationByOrder.map((n, i) => {
    const shared = {
      id: `${tourId}-seg-${i}`,
      kind: n.kind,
      order: i,
      title: n.title,
      script: n.script,
      // null in this plan — narration is spoken by speechSynthesis. Chirp
      // voices arrive in Plan 2b and fill these in then.
      audioUrl: null,
      durationMs: null,
    };

    if (n.kind === 'intro' || n.kind === 'outro') {
      return { ...shared, trigger: null, triggerRadiusM: 0, poiIds: [] };
    }

    if (n.kind === 'stop') {
      const stop = byOrder[nextStopIndex];
      const triggerRadiusM = route.triggerRadiiM[nextStopIndex];
      nextStopIndex += 1;
      return { ...shared, trigger: stop.standingPoint, triggerRadiusM, poiIds: stop.wikidataQids };
    }

    // 'walk': departs from the stop most recently assigned — reuse ITS
    // derived radius (see the module doc on why a wider, motion-tolerant
    // radius matters here) and its corresponding walk cue point.
    const departingStopIndex = nextStopIndex - 1;
    return {
      ...shared,
      trigger: route.walkCuePoints[departingStopIndex],
      triggerRadiusM: route.triggerRadiiM[departingStopIndex],
      poiIds: [],
    };
  });

  return {
    id: tourId,
    city,
    language: request.language,
    persona: request.persona,
    profileText: request.profileText,
    title: tourTitle,
    segments,
    routeGeoJson: route.line,
    estimatedDurationMin: computeEstimatedDurationMin(route, byOrder.length, { segments: narrationByOrder }),
  };
}
