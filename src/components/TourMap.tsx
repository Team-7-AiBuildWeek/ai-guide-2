import { useEffect, useRef } from 'react';
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

  // Initialise the map once.
  useEffect(() => {
    if (map.current !== null || container.current === null) return;

    const start = tour.routeGeoJson.coordinates[0];
    map.current = new mapboxgl.Map({
      container: container.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: start,
      zoom: 15,
    });

    map.current.on('load', () => {
      const m = map.current;
      if (!m) return;

      m.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: tour.routeGeoJson },
      });
      m.addLayer({
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
          .addTo(m);
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
      map.current?.remove();
      map.current = null;
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

  return <div ref={container} className="h-full w-full" />;
}
