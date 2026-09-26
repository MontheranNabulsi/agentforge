import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation identifiers for the current unit of work (an HTTP request or a job).
 * The logger reads them on every line, so code never passes a logger or ids around
 * just to keep logs traceable.
 */
export interface RequestContext {
  requestId?: string;
  userId?: string;
  organizationId?: string;
  projectId?: string;
  runId?: string;
  jobId?: string;
  queue?: string;
  traceId?: string;
  ip?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(context: RequestContext, work: () => T): T {
    return storage.run({ ...context }, work);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Adds fields to the current context (e.g. userId once the session is resolved). */
  set(patch: Partial<RequestContext>): void {
    const current = storage.getStore();
    if (current) Object.assign(current, patch);
  },
  enterWith(context: RequestContext): void {
    storage.enterWith({ ...context });
  },
};
