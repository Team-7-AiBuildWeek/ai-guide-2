import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Tour } from '../types/tour';
import type { Fix } from '../lib/location/types';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

interface TourMapProps {
  tour: Tour;
  lastFix: Fix | null;
  playedIds: ReadonlySet<string>;
  onSelectStop: (id: string) => void;
}

export function TourMap({ tour, lastFix, playedIds, onSelectStop }: TourMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const stopMarkers = useRef<Map<string, mapboxgl.Marker>>(new Map());
  // The map is an aid, not the product — a missing/expired token, a 404'd
  // style, or no network must degrade to a placeholder, never take the
  // whole app down. Both throw paths land here: the synchronous
  // mapboxgl.Map constructor (caught below) and mapbox's own async
  // 'error' event (registered below).
  const [failed, setFailed] = useState(false);

  // Initialise the map once.
  useEffect(() => {
    if (map.current !== null || container.current === null) return;

    // Captured locally and closed over by every handler below — never
    // `map.current` — so a handler registered on this instance can never act
    // on a *different* instance that has since replaced it in the ref. Under
    // React StrictMode's mount → cleanup → mount, the first instance's `load`
    // event could otherwise arrive after `map.current` has been reassigned to
    // the second instance, making a stale handler run its setup against the
    // wrong map. Closing over the local makes that impossible by
    // construction, independent of library internals or event timing.
    let instance: mapboxgl.Map;
    try {
      const start = tour.routeGeoJson.coordinates[0];
      instance = new mapboxgl.Map({
        container: container.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: start,
        zoom: 15,
      });
      map.current = instance;
    } catch {
      // e.g. "An API access token is required to use Mapbox GL" — thrown
      // synchronously out of the constructor when the token is missing.
      setFailed(true);
      return;
    }

    // Asynchronous failures — a 404'd style, a token revoked mid-session —
    // arrive as an event rather than a throw. Route them into the same
    // degraded state as the synchronous catch above.
    instance.on('error', () => setFailed(true));

    instance.on('load', () => {
      instance.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: tour.routeGeoJson },
      });
      instance.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.75 },
      });

      for (const segment of tour.segments) {
        if (segment.trigger === null || segment.kind !== 'stop') continue;

        const el = document.createElement('button');
        el.className =
          'h-7 w-7 rounded-full border-2 border-white bg-blue-600 text-xs font-bold text-white shadow';
        el.textContent = String(segment.order);
        el.setAttribute('aria-label', `Play ${segment.title}`);
        el.addEventListener('click', () => onSelectStop(segment.id));

        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([segment.trigger.lng, segment.trigger.lat])
          .addTo(instance);
        stopMarkers.current.set(segment.id, marker);
      }
    });

    return () => {
      const markers = stopMarkers.current;
      for (const marker of markers.values()) {
        marker.remove();
      }
      markers.clear();
      const marker = userMarker.current;
      marker?.remove();
      userMarker.current = null;
      instance.remove();
      if (map.current === instance) map.current = null;
    };
  }, [tour, onSelectStop]);

  // Follow the user.
  useEffect(() => {
    const m = map.current;
    if (!m || lastFix === null) return;

    if (userMarker.current === null) {
      const el = document.createElement('div');
      el.className = 'h-4 w-4 rounded-full border-2 border-white bg-red-500 shadow';
      userMarker.current = new mapboxgl.Marker({ element: el });
    }
    userMarker.current.setLngLat([lastFix.lng, lastFix.lat]).addTo(m);
    m.easeTo({ center: [lastFix.lng, lastFix.lat], duration: 700 });
  }, [lastFix]);

  // Grey out stops already visited.
  useEffect(() => {
    for (const [id, marker] of stopMarkers.current) {
      const el = marker.getElement();
      el.classList.toggle('bg-blue-600', !playedIds.has(id));
      el.classList.toggle('bg-slate-400', playedIds.has(id));
    }
  }, [playedIds]);

  return (
    <>
      <div ref={container} className="h-full w-full" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-800 px-6 text-center text-sm text-slate-300">
          Map unavailable right now. The tour will keep talking as you walk.
        </div>
      )}
    </>
  );
}
