import { conflict } from '../../../shared-kernel/errors';

export type RunStatus =
  'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type RunIntent = 'question' | 'task' | 'chitchat' | 'out_of_scope' | 'unsafe';

export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running', 'awaiting_approval'];
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
];

/** The run state machine. Anything not listed is an illegal transition. */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'timed_out'],
  awaiting_approval: ['running', 'cancelled', 'failed', 'timed_out'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to))
    throw conflict('INVALID_RUN_TRANSITION', `A ${from} run cannot become ${to}`);
}

export const isTerminal = (status: RunStatus) => TERMINAL_STATUSES.includes(status);

export type RunErrorCode =
  | 'LLM_UNAVAILABLE'
  | 'LLM_RATE_LIMITED'
  | 'LLM_AUTH'
  | 'LLM_BAD_REQUEST'
  | 'LLM_INVALID_OUTPUT'
  | 'TOOL_TIMEOUT'
  | 'BUDGET_EXCEEDED'
  | 'DEADLINE_EXCEEDED'
  | 'VALIDATION_FAILED'
  | 'APPROVAL_EXPIRED'
  | 'CANCELLED'
  | 'INTERNAL';

/** Thrown inside a run to stop it with a specific terminal status and error code. */
export class RunStopped extends Error {
  constructor(
    readonly code: RunErrorCode,
    message: string,
    readonly status: 'failed' | 'cancelled' | 'timed_out',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RunStopped';
  }
}

// ---------------------------------------------------------------------------------------
// Budgets: every run is bounded in steps, tool calls, tokens and wall-clock time.
// ---------------------------------------------------------------------------------------

export interface RunLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxTokens: number;
  timeoutSeconds: number;
}

export interface RunUsage {
  modelTurns: number;
  toolCalls: number;
  tokens: number;
}

export function budgetViolation(
  usage: RunUsage,
  limits: RunLimits,
  now: Date,
  deadlineAt: Date | null,
): RunStopped | null {
  if (deadlineAt && now.getTime() > deadlineAt.getTime()) {
    return new RunStopped(
      'DEADLINE_EXCEEDED',
      `The run exceeded its ${limits.timeoutSeconds}s time limit`,
      'timed_out',
    );
  }
  if (usage.modelTurns >= limits.maxSteps) {
    return new RunStopped(
      'BUDGET_EXCEEDED',
      `The run reached its limit of ${limits.maxSteps} model steps`,
      'failed',
    );
  }
  if (usage.toolCalls > limits.maxToolCalls) {
    return new RunStopped(
      'BUDGET_EXCEEDED',
      `The run reached its limit of ${limits.maxToolCalls} tool calls`,
      'failed',
    );
  }
  if (usage.tokens > limits.maxTokens) {
    return new RunStopped(
      'BUDGET_EXCEEDED',
      `The run used more than its ${limits.maxTokens}-token budget`,
      'failed',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Retries: exponential backoff with full jitter (AWS Architecture Blog, "Exponential Backoff
// And Jitter"): delay = random(0, min(cap, base · 2^(attempt-1))). Jitter spreads retries so
// clients that failed together don't retry together.
// ---------------------------------------------------------------------------------------

export function backoffDelayMs(
  attempt: number,
  options: { baseMs: number; maxMs: number } = { baseMs: 500, maxMs: 8_000 },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}
