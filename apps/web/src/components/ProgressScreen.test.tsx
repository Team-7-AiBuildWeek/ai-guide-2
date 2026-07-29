import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { JobEvent } from '../lib/api/client';
import { ProgressScreen } from './ProgressScreen';

/** A stub `subscribeToJob` that hands back whatever event sequence the test
 * hands it, starting with the one queued for "connect". Mirrors the real
 * contract: the very first event delivered is the job's current state,
 * never assumed to be the beginning — that's what makes joining a job
 * already in progress (screen-sleep reconnect) identical to joining fresh. */
function stubSubscribe(events: JobEvent[]) {
  const unsubscribe = vi.fn();
  const subscribeToJob = vi.fn((_jobId: string, onEvent: (job: JobEvent) => void) => {
    for (const event of events) onEvent(event);
    return unsubscribe;
  });
  return { subscribeToJob, unsubscribe };
}

function stageRow(label: string): HTMLElement {
  return screen.getByText(label).closest('li') as HTMLElement;
}

describe('ProgressScreen', () => {
  it('renders the earlier three stages as complete when it joins a job already at narration', () => {
    const { subscribeToJob } = stubSubscribe([
      { status: 'running', stage: 'narration', tourId: null, error: null },
    ]);

    render(
      <ProgressScreen
        jobId="job-1"
        subscribeToJob={subscribeToJob}
        onComplete={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(stageRow('Finding places').textContent).toContain('Done');
    expect(stageRow('Choosing stops').textContent).toContain('Done');
    expect(stageRow('Planning the route').textContent).toContain('Done');
    expect(stageRow('Writing narration').textContent).toContain('In progress');
  });

  it('renders every stage complete and calls onComplete when it joins an already-finished job', () => {
    const { subscribeToJob } = stubSubscribe([
      { status: 'done', stage: 'narration', tourId: 'tour-99', error: null },
    ]);
    const onComplete = vi.fn();

    render(
      <ProgressScreen
        jobId="job-1"
        subscribeToJob={subscribeToJob}
        onComplete={onComplete}
        onRetry={vi.fn()}
      />,
    );

    for (const label of ['Finding places', 'Choosing stops', 'Planning the route', 'Writing narration']) {
      expect(stageRow(label).textContent).toContain('Done');
    }
    expect(onComplete).toHaveBeenCalledWith('tour-99');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('names the failed stage and offers Retry, without marking later stages complete', () => {
    const { subscribeToJob } = stubSubscribe([
      { status: 'failed', stage: 'routing', tourId: null, error: 'Mapbox rate limited' },
    ]);
    const onRetry = vi.fn();

    render(
      <ProgressScreen
        jobId="job-1"
        subscribeToJob={subscribeToJob}
        onComplete={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(stageRow('Finding places').textContent).toContain('Done');
    expect(stageRow('Choosing stops').textContent).toContain('Done');
    expect(stageRow('Planning the route').textContent).toContain('Failed');
    expect(stageRow('Writing narration').textContent).toContain('Waiting');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Planning the route');
    expect(alert.textContent).toContain('Mapbox rate limited');

    screen.getByRole('button', { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders every stage waiting before any event has arrived', () => {
    const subscribeToJob = vi.fn(() => vi.fn());

    render(
      <ProgressScreen jobId="job-1" subscribeToJob={subscribeToJob} onComplete={vi.fn()} onRetry={vi.fn()} />,
    );

    for (const label of ['Finding places', 'Choosing stops', 'Planning the route', 'Writing narration']) {
      expect(stageRow(label).textContent).toContain('Waiting');
    }
  });

  it('unsubscribes on unmount so no EventSource is left leaking battery', () => {
    const unsubscribe = vi.fn();
    const subscribeToJob = vi.fn(() => unsubscribe);

    const { unmount } = render(
      <ProgressScreen jobId="job-1" subscribeToJob={subscribeToJob} onComplete={vi.fn()} onRetry={vi.fn()} />,
    );

    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes immediately on a terminal event, not just at unmount', () => {
    const { subscribeToJob, unsubscribe } = stubSubscribe([
      { status: 'done', stage: 'narration', tourId: 'tour-1', error: null },
    ]);

    render(
      <ProgressScreen jobId="job-1" subscribeToJob={subscribeToJob} onComplete={vi.fn()} onRetry={vi.fn()} />,
    );

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
