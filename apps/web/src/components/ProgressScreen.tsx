import { useEffect, useRef, useState } from 'react';
import type { JobEvent, JobStage } from '../lib/api/client';

const STAGES: { id: JobStage; label: string }[] = [
  { id: 'discovery', label: 'Finding places' },
  { id: 'curation', label: 'Choosing stops' },
  { id: 'routing', label: 'Planning the route' },
  { id: 'narration', label: 'Writing narration' },
];

type StageStatus = 'complete' | 'current' | 'failed' | 'pending';

function stageStatus(job: JobEvent | null, stageId: JobStage, index: number, currentIndex: number): StageStatus {
  if (!job) return 'pending';
  if (job.status === 'done') return 'complete';
  if (job.status === 'failed') {
    if (job.stage === stageId) return 'failed';
    return currentIndex >= 0 && index < currentIndex ? 'complete' : 'pending';
  }
  // queued or running
  if (currentIndex < 0) return 'pending';
  if (index < currentIndex) return 'complete';
  if (index === currentIndex) return 'current';
  return 'pending';
}

const STATUS_LABEL: Record<StageStatus, string> = {
  complete: 'Done',
  current: 'In progress',
  failed: 'Failed',
  pending: 'Waiting',
};

export interface ProgressScreenProps {
  jobId: string;
  subscribeToJob: (jobId: string, onEvent: (job: JobEvent) => void) => () => void;
  /** Called once, when the job's SSE stream reports `status: 'done'`. */
  onComplete: (tourId: string) => void;
  onRetry: () => void;
}

/**
 * Watches a generation job over SSE. Must render correctly the instant it
 * mounts, without ever having seen an intermediate event — task 10
 * guarantees the first event on a (re)connect always carries the job's
 * current state, which is what makes joining a job already halfway through,
 * or already finished, indistinguishable from joining at the start. That is
 * exactly what happens whenever a phone screen sleeps mid-generation.
 */
export function ProgressScreen({ jobId, subscribeToJob, onComplete, onRetry }: ProgressScreenProps) {
  const [job, setJob] = useState<JobEvent | null>(null);

  // A ref, not a plain local variable, because the stub (and a real
  // EventSource under the right timing) can invoke the event callback
  // synchronously from inside `subscribeToJob` itself — before its return
  // value would otherwise have been assigned. Reading/writing through a ref
  // that a *different* effect (below) reacts to on the next commit sidesteps
  // that ordering hazard entirely.
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    unsubscribeRef.current = subscribeToJob(jobId, (event) => {
      if (active) setJob(event);
    });
    return () => {
      active = false;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [jobId, subscribeToJob]);

  // Nothing more will ever arrive for a terminal job — close the connection
  // as soon as one is seen, rather than waiting for unmount, so a finished
  // job doesn't sit there costing battery until the app switches screens.
  useEffect(() => {
    if (job?.status === 'done' || job?.status === 'failed') {
      unsubscribeRef.current?.();
    }
  }, [job]);

  useEffect(() => {
    if (job?.status === 'done' && job.tourId) {
      onComplete(job.tourId);
    }
  }, [job, onComplete]);

  const currentIndex = job?.stage ? STAGES.findIndex((s) => s.id === job.stage) : -1;
  const failedStage = job?.status === 'failed' ? STAGES.find((s) => s.id === job.stage) : undefined;

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-slate-900 px-8 text-center text-white">
      <h1 className="text-xl font-semibold">Building your tour</h1>

      <ul className="w-full max-w-xs space-y-2 text-left">
        {STAGES.map((stage, index) => {
          const status = stageStatus(job, stage.id, index, currentIndex);
          return (
            <li
              key={stage.id}
              className="flex items-center justify-between rounded bg-slate-800 px-3 py-2 text-sm"
            >
              <span>{stage.label}</span>
              <span
                className={
                  status === 'failed'
                    ? 'font-semibold text-red-400'
                    : status === 'complete'
                      ? 'text-emerald-400'
                      : status === 'current'
                        ? 'font-semibold text-blue-400'
                        : 'text-slate-500'
                }
              >
                {STATUS_LABEL[status]}
              </span>
            </li>
          );
        })}
      </ul>

      {job?.status === 'failed' && (
        <div role="alert" className="w-full max-w-xs space-y-3 rounded-lg bg-red-950 p-4">
          <p className="text-sm">
            {(failedStage?.label ?? 'Generation')} failed{job.error ? `: ${job.error}` : '.'}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="w-full rounded-full bg-blue-600 px-6 py-2 text-sm font-semibold"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
