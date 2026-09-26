import type { ProblemDetails } from '@agentforge/contracts';

/** An API failure, carrying the RFC 9457 problem details the server returned. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: { path: string; message: string }[];
  readonly requestId: string | undefined;

  constructor(status: number, problem: Partial<ProblemDetails>) {
    super(problem.detail ?? problem.title ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem.code ?? 'UNKNOWN';
    this.fieldErrors = problem.errors ?? [];
    this.requestId = problem.requestId;
  }
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Json | FormData | undefined;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Same-origin calls to /api/v1 with the session cookie; errors become ApiError. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = options.body === undefined ? 'GET' : 'POST',
    body,
    headers = {},
    signal,
  } = options;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: isForm ? (body as FormData) : JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, (data ?? {}) as Partial<ProblemDetails>);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 200) };
  }
}

export const idempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
