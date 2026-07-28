import type { Tour } from '../types/tour';

interface StopListProps {
  tour: Tour;
  playedIds: ReadonlySet<string>;
  currentId: string | null;
  onSelect: (id: string) => void;
}

export function StopList({ tour, playedIds, currentId, onSelect }: StopListProps) {
  const stops = tour.segments.filter((s) => s.kind === 'stop');

  return (
    <ul className="divide-y divide-slate-200 overflow-y-auto">
      {stops.map((stop) => (
        <li key={stop.id}>
          <button
            onClick={() => onSelect(stop.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-100"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                currentId === stop.id
                  ? 'bg-emerald-600'
                  : playedIds.has(stop.id)
                    ? 'bg-slate-400'
                    : 'bg-blue-600'
              }`}
            >
              {stop.order}
            </span>
            <span className="text-sm font-medium text-slate-900">{stop.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
