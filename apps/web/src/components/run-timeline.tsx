'use client';

import type { RunDetailDto, RunEvent, StepDto, ToolCallDto } from '@agentforge/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleX,
  Hourglass,
  ListChecks,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Tags,
  Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { StatusBadge } from '@/components/status';
import { api } from '@/lib/api';
import { compact, duration } from '@/lib/format';
import { useRunEvents } from '@/lib/run-events';
import { cn } from '@/lib/utils';

export const TERMINAL = ['completed', 'failed', 'cancelled', 'timed_out'];

/**
 * Run detail kept fresh by the run's live event stream, plus the answer text as it streams.
 * The stream stays open until the terminal event arrives (not merely until a refetch shows a
 * terminal status), so the caller's onTerminal always fires exactly once per live run.
 */
export function useLiveRun(
  runId: string | null | undefined,
  onTerminal?: (event: RunEvent) => void,
) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api<RunDetailDto>(`/runs/${runId}`),
    enabled: Boolean(runId),
  });
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const terminalRef = useRef(onTerminal);
  terminalRef.current = onTerminal;
  const status = detail.data?.id === runId ? detail.data?.status : undefined;

  useEffect(() => {
    setStreamText('');
    setStreaming(false);
  }, [runId]);

  useEffect(() => {
    if (status && !TERMINAL.includes(status)) setStreaming(true);
  }, [status]);

  const notified = useRef<string | null>(null);
  const finish = (event: Extract<RunEvent, { type: 'run.completed' | 'run.failed' }>) => {
    setStreaming(false);
    void queryClient.invalidateQueries({ queryKey: ['run', runId] });
    if (notified.current === event.runId) return;
    notified.current = event.runId;
    terminalRef.current?.(event);
  };

  // The run may already have finished by the time we first look at it (fast runs): report
  // that as a terminal event too, so callers refresh whatever the run produced.
  useEffect(() => {
    if (!runId || !status || !TERMINAL.includes(status) || streaming || notified.current === runId)
      return;
    const at = new Date().toISOString();
    finish(
      status === 'completed'
        ? { type: 'run.completed', runId, messageId: null, at }
        : {
            type: 'run.failed',
            runId,
            status: status as 'failed',
            errorCode: detail.data?.errorCode ?? 'INTERNAL',
            message: detail.data?.error?.message ?? 'The run failed',
            at,
          },
    );
  }, [runId, status, streaming]);

  // Safety net: the run is terminal in the database but the terminal event never arrived
  // (for example the event stream expired). Finish anyway after a short grace period.
  useEffect(() => {
    if (!streaming || !status || !TERMINAL.includes(status) || !runId) return;
    const handle = window.setTimeout(() => {
      const at = new Date().toISOString();
      finish(
        status === 'completed'
          ? { type: 'run.completed', runId, messageId: null, at }
          : {
              type: 'run.failed',
              runId,
              status: status as 'failed',
              errorCode: detail.data?.errorCode ?? 'INTERNAL',
              message: detail.data?.error?.message ?? 'The run failed',
              at,
            },
      );
    }, 2_500);
    return () => window.clearTimeout(handle);
  }, [streaming, status, runId]);

  const refresh = () => {
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      void queryClient.invalidateQueries({ queryKey: ['run', runId] });
    }, 250);
  };

  useRunEvents(streaming ? runId : null, (event) => {
    if (event.type === 'message.delta') setStreamText((text) => text + event.text);
    else if (event.type === 'message.reset') setStreamText('');
    else if (event.type === 'run.completed' || event.type === 'run.failed') finish(event);
    else refresh();
  });

  return { detail, streamText, live: streaming };
}

const KIND_ICON: Record<StepDto['kind'], typeof Tags> = {
  classify: Tags,
  plan: ListChecks,
  retrieve: Search,
  model_call: Sparkles,
  tool_call: Wrench,
  approval_wait: Hourglass,
  validate: ShieldCheck,
  finalize: CircleCheck,
};

function StepIcon({ step }: { step: StepDto }) {
  const Icon =
    step.status === 'running'
      ? LoaderCircle
      : step.status === 'failed'
        ? CircleX
        : KIND_ICON[step.kind];
  return (
    <span
      className={cn(
        'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-card',
        step.status === 'failed'
          ? 'border-danger/40 text-danger'
          : step.status === 'running'
            ? 'border-info/40 text-info'
            : 'border-border text-muted-foreground',
      )}
    >
      <Icon className={cn('size-3.5', step.status === 'running' && 'animate-spin')} />
    </span>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ToolCallDetails({ call }: { call: ToolCallDto }) {
  return (
    <details className="mt-1.5 rounded-lg border border-border bg-subtle text-xs">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1">
        <span className="font-mono">{call.toolName}</span>
        <StatusBadge status={call.status} />
        <span className="ml-auto text-muted-foreground">{duration(call.durationMs)}</span>
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        <div>
          <p className="mb-1 font-medium text-muted-foreground">Input</p>
          <Json value={call.input} />
        </div>
        <div>
          <p className="mb-1 font-medium text-muted-foreground">
            Output {call.outputSummary ? `· ${call.outputSummary}` : ''}
          </p>
          <Json value={call.output ?? call.error} />
        </div>
      </div>
    </details>
  );
}

/**
 * What the agent did, step by step: execution metadata only (which step, which tool, inputs and
 * outputs, timing, tokens, validation), never hidden model reasoning.
 */
export function RunTimeline({ run, dense = false }: { run: RunDetailDto; dense?: boolean }) {
  const callsByStep = new Map<string, ToolCallDto[]>();
  for (const call of run.toolCalls) {
    if (!call.stepId) continue;
    callsByStep.set(call.stepId, [...(callsByStep.get(call.stepId) ?? []), call]);
  }
  return (
    <ol className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-3 before:w-px before:bg-border">
      {run.steps.map((step) => (
        <li key={step.id} className="relative flex gap-3">
          <StepIcon step={step} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{step.name}</span>
              <span className="text-xs text-muted-foreground">
                {step.status === 'running' ? 'running…' : duration(step.durationMs)}
              </span>
              {step.promptTokens + step.completionTokens > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {compact(step.promptTokens)} in · {compact(step.completionTokens)} out
                </span>
              ) : null}
            </div>
            {step.summary ? (
              <p className={cn('text-xs text-muted-foreground', dense ? 'line-clamp-2' : '')}>
                {step.summary}
              </p>
            ) : null}
            {step.error ? (
              <p className="mt-1 text-xs text-danger">
                {step.error.code}: {step.error.message}
              </p>
            ) : null}
            {(callsByStep.get(step.id) ?? []).map((call) => (
              <ToolCallDetails key={call.id} call={call} />
            ))}
            {!dense && step.kind === 'validate' && Array.isArray(step.detail.checks) ? (
              <ul className="mt-1 space-y-0.5 text-xs">
                {(step.detail.checks as { name: string; passed: boolean; detail: string }[]).map(
                  (check) => (
                    <li key={check.name} className="flex gap-1.5">
                      {check.passed ? (
                        <CircleCheck className="mt-0.5 size-3 text-success" />
                      ) : (
                        <CircleX className="mt-0.5 size-3 text-warning" />
                      )}
                      <span>
                        <span className="font-mono">{check.name}</span> —{' '}
                        <span className="text-muted-foreground">{check.detail}</span>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
      {run.steps.length === 0 ? (
        <li className="relative flex gap-3 text-sm text-muted-foreground">
          <span className="relative z-10 flex size-6 items-center justify-center rounded-full border border-border bg-card">
            <LoaderCircle className="size-3.5 animate-spin" />
          </span>
          Waiting for a worker…
        </li>
      ) : null}
    </ol>
  );
}
