'use client';

import type { RunEvent } from '@agentforge/contracts';
import { useEffect, useRef } from 'react';

/**
 * Subscribes to a run's server-sent events. EventSource reconnects on its own and sends
 * Last-Event-ID, so a dropped connection resumes without gaps. Closed on the terminal event.
 */
export function useRunEvents(
  runId: string | null | undefined,
  onEvent: (event: RunEvent) => void,
): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/v1/runs/${runId}/events`, { withCredentials: true });
    const types: RunEvent['type'][] = [
      'run.status',
      'step.started',
      'step.completed',
      'tool_call.started',
      'tool_call.completed',
      'approval.requested',
      'approval.decided',
      'message.delta',
      'message.reset',
      'run.completed',
      'run.failed',
    ];
    const listener = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as RunEvent;
        handler.current(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') source.close();
      } catch {
        // ignore malformed events
      }
    };
    for (const type of types) source.addEventListener(type, listener as EventListener);
    return () => source.close();
  }, [runId]);
}
