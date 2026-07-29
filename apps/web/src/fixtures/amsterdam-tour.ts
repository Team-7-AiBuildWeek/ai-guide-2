import type { Tour } from '@ai-guide/shared';

/**
 * A five-stop walk through central Amsterdam, hand-authored so the player can
 * be exercised before the generation pipeline exists. Coordinates are real;
 * narration is placeholder prose, not the product's voice.
 *
 * Spec Â§8 requires walk cues to fire on *departure* from a stop rather than on
 * arrival at the next one. That is achieved by placement, not by engine logic:
 * a 'walk' segment's trigger sits roughly 25% of the way along the leg from
 * the preceding stop to the next one â€” unambiguously past departure (clear of
 * the preceding stop's own trigger radius) and comfortably before arrival, so
 * it cannot be mistaken for either neighbour's trigger. The trigger coordinate
 * must also sit on or very near the route line, since the simulator and the
 * off-route check both measure distance to that line. Plan 2's routing stage
 * must preserve this convention when it generates walk segments.
 */
export const amsterdamTour: Tour = {
  id: 'fixture-amsterdam-01',
  city: 'Amsterdam',
  language: 'en',
  persona: 'historian',
  title: 'Centre and Jordaan â€” a short loop',
  estimatedDurationMin: 35,
  routeGeoJson: {
    type: 'LineString',
    coordinates: [
      [4.8936, 52.3731],
      [4.8912, 52.3731],
      [4.8887, 52.3738],
      [4.884, 52.3747],
      [4.8843, 52.3789],
    ],
  },
  segments: [
    {
      id: 'intro',
      kind: 'intro',
      order: 0,
      title: 'Welcome',
      script:
        'Welcome to a short walk through the centre of Amsterdam. Keep your phone in hand, and I will start talking whenever we reach somewhere worth stopping.',
      audioUrl: null,
      durationMs: null,
      trigger: null,
      triggerRadiusM: 0,
      poiIds: [],
    },
    {
      id: 'dam-square',
      kind: 'stop',
      order: 1,
      title: 'Dam Square',
      script:
        'You are standing on Dam Square, the spot the whole city grew out of. A dam was thrown across the river Amstel here in the thirteenth century, and the settlement that formed behind it took its name from the act: Amstel-dam.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3731, lng: 4.8936 },
      triggerRadiusM: 30,
      poiIds: ['Q621594'],
    },
    {
      id: 'walk-to-palace',
      kind: 'walk',
      order: 2,
      title: 'Toward the palace',
      script:
        'Carry on west across the square, keeping the large neoclassical building on your right.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3731, lng: 4.893 },
      triggerRadiusM: 25,
      poiIds: [],
    },
    {
      id: 'royal-palace',
      kind: 'stop',
      order: 3,
      title: 'Royal Palace',
      script:
        'This was never meant to be a palace. It opened in 1655 as Amsterdamâ€™s city hall, at a moment when the city was arguably the richest in Europe, and it was built to say exactly that.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3731, lng: 4.8912 },
      triggerRadiusM: 30,
      poiIds: ['Q224964'],
    },
    {
      id: 'westerkerk',
      kind: 'stop',
      order: 4,
      title: 'Westerkerk',
      script:
        'The Westerkerkâ€™s tower is the tallest in the city, and its bells are the ones Anne Frank wrote about hearing from the annexe a few doors along the canal.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3747, lng: 4.884 },
      triggerRadiusM: 30,
      poiIds: ['Q1547588'],
    },
    {
      id: 'noordermarkt',
      kind: 'stop',
      order: 5,
      title: 'Noordermarkt',
      script:
        'You have crossed into the Jordaan, built as a working district for the people who could not afford the canal belt behind you. The square holds a market on Saturdays that locals still actually use.',
      audioUrl: null,
      durationMs: null,
      trigger: { lat: 52.3789, lng: 4.8843 },
      triggerRadiusM: 30,
      poiIds: ['Q2262940'],
    },
    {
      id: 'outro',
      kind: 'outro',
      order: 6,
      title: 'That is the walk',
      script: 'That is the end of the loop. Thanks for walking it.',
      audioUrl: null,
      durationMs: null,
      trigger: null,
      triggerRadiusM: 0,
      poiIds: [],
    },
  ],
};
