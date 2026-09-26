/**
 * Provider-neutral AI ports. Nothing above these interfaces knows which vendor answers:
 * the Anthropic adapter, the deterministic fakes and any future adapter translate to and
 * from these shapes. Deliberately library-free (no SDK or schema-library types), so the
 * application layer can depend on it without depending on a vendor.
 */

export type ModelProfile = 'fast' | 'default';

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input (type: "object"). */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; isError?: boolean };

/** Why the model is being called; used for telemetry and by the deterministic fakes. */
export type LlmPurpose = 'classify' | 'plan' | 'act' | 'repair' | 'judge' | 'title';

export interface LlmRequest {
  profile: ModelProfile;
  purpose: LlmPurpose;
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** True when the provider did not report usage and the numbers are estimates. */
  estimated: boolean;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: LlmToolCall }
  | { type: 'done'; stopReason: LlmStopReason; usage: LlmUsage; model: string };

/** A schema the adapter can hand to the model (JSON Schema) and then enforce itself (parse). */
export interface ObjectSchema<T> {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  parse(value: unknown): T;
}

export interface LlmObjectRequest<T> {
  profile: ModelProfile;
  purpose: LlmPurpose;
  system: string;
  messages: LlmMessage[];
  schema: ObjectSchema<T>;
  maxTokens?: number;
}

export interface LlmObjectResult<T> {
  object: T;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  /** "anthropic", "fake" … recorded on every run. */
  readonly name: string;
  /** True for deterministic providers: the UI labels their output as a demo, not AI. */
  readonly deterministic: boolean;
  modelFor(profile: ModelProfile): string;
  streamTurn(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
  generateObject<T>(request: LlmObjectRequest<T>, signal: AbortSignal): Promise<LlmObjectResult<T>>;
}

export type LlmErrorCode =
  'LLM_UNAVAILABLE' | 'LLM_RATE_LIMITED' | 'LLM_BAD_REQUEST' | 'LLM_AUTH' | 'LLM_INVALID_OUTPUT';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
