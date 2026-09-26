import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  type LlmMessage,
  type LlmObjectRequest,
  type LlmObjectResult,
  type LlmProvider,
  type LlmRequest,
  type LlmStopReason,
  type LlmStreamEvent,
  type LlmToolCall,
  type ModelProfile,
} from '../../shared-kernel/ai';

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

/**
 * Claude via the Messages API.
 *
 * Translation rules (the only place that knows Anthropic's shapes):
 * - our `tool` messages become `tool_result` blocks inside a user turn;
 * - consecutive same-role turns are merged (the API expects alternating roles);
 * - structured output uses a forced tool call whose input schema is the object schema,
 *   then the result is validated again with our own parser (provider guarantees are not trusted).
 *
 * The SDK's built-in retries are disabled: retries happen in the orchestrator, where each
 * attempt is recorded on the run's step.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly deterministic = false;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly models: Record<ModelProfile, string>,
    options: { baseURL?: string; timeoutMs?: number } = {},
  ) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: options.timeoutMs ?? 120_000,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  modelFor(profile: ModelProfile): string {
    return this.models[profile];
  }

  async *streamTurn(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const model = this.modelFor(request.profile);
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(
        {
          model,
          max_tokens: request.maxTokens ?? 2_048,
          temperature: request.temperature ?? 0.2,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
          stream: true,
        },
        { signal },
      );
    } catch (error) {
      throw toLlmError(error);
    }

    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: LlmStopReason = 'other';
    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens;
            outputTokens = event.message.usage.output_tokens;
            break;
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              toolBlocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                json: '',
              });
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const block = toolBlocks.get(event.index);
              if (block) block.json += event.delta.partial_json;
            }
            break;
          case 'content_block_stop': {
            const block = toolBlocks.get(event.index);
            if (block) {
              yield { type: 'tool_call', call: parseToolCall(block) };
              toolBlocks.delete(event.index);
            }
            break;
          }
          case 'message_delta':
            outputTokens = event.usage.output_tokens ?? outputTokens;
            stopReason = mapStopReason(event.delta.stop_reason);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      throw toLlmError(error);
    }
    yield {
      type: 'done',
      stopReason,
      usage: { inputTokens, outputTokens, estimated: false },
      model,
    };
  }

  async generateObject<T>(
    request: LlmObjectRequest<T>,
    signal: AbortSignal,
  ): Promise<LlmObjectResult<T>> {
    const model = this.modelFor(request.profile);
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model,
          max_tokens: request.maxTokens ?? 1_024,
          temperature: 0,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: [
            {
              name: request.schema.name,
              description: request.schema.description,
              input_schema: request.schema.jsonSchema as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: request.schema.name },
        },
        { signal },
      );
    } catch (error) {
      throw toLlmError(error);
    }
    const toolUse = message.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new LlmError(
        'LLM_INVALID_OUTPUT',
        'The model did not return the requested object',
        true,
      );
    }
    let object: T;
    try {
      object = request.schema.parse(toolUse.input);
    } catch (error) {
      throw new LlmError(
        'LLM_INVALID_OUTPUT',
        `The model returned an invalid ${request.schema.name}`,
        true,
        { cause: error },
      );
    }
    return {
      object,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        estimated: false,
      },
      model,
    };
  }
}

export function toAnthropicMessages(messages: LlmMessage[]): MessageParam[] {
  const result: MessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: ContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = result.at(-1);
    if (last && last.role === role) {
      const existing =
        typeof last.content === 'string'
          ? [{ type: 'text' as const, text: last.content }]
          : last.content;
      last.content = [...existing, ...blocks];
    } else {
      result.push({ role, content: blocks });
    }
  };
  for (const message of messages) {
    if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.content }]);
    } else if (message.role === 'assistant') {
      const blocks: ContentBlockParam[] = [];
      if (message.content.trim()) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      push('assistant', blocks);
    } else {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
        },
      ]);
    }
  }
  return result;
}

function parseToolCall(block: { id: string; name: string; json: string }): LlmToolCall {
  let input: Record<string, unknown> = {};
  if (block.json.trim()) {
    try {
      const parsed: unknown = JSON.parse(block.json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        input = parsed as Record<string, unknown>;
    } catch {
      input = { __invalid_json: block.json };
    }
  }
  return { id: block.id, name: block.name, input };
}

function mapStopReason(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError('LLM_RATE_LIMITED', 'The model provider is rate limiting requests', true, {
      cause: error,
    });
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new LlmError('LLM_AUTH', 'The model provider rejected the API key', false, {
      cause: error,
    });
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new LlmError(
      'LLM_BAD_REQUEST',
      `The model provider rejected the request: ${error.message}`,
      false,
      { cause: error },
    );
  }
  if (error instanceof Anthropic.APIUserAbortError) {
    return new LlmError('LLM_UNAVAILABLE', 'The request was cancelled', false, { cause: error });
  }
  // Timeouts, connection failures, 5xx and 529 (overloaded) are worth retrying.
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError('LLM_UNAVAILABLE', `The model provider is unavailable: ${message}`, true, {
    cause: error,
  });
}
