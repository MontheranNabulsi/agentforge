import {
  LlmError,
  type LlmMessage,
  type LlmObjectRequest,
  type LlmObjectResult,
  type LlmProvider,
  type LlmPurpose,
  type LlmRequest,
  type LlmStreamEvent,
  type LlmToolCall,
  type ModelProfile,
} from '../../shared-kernel/ai';
import { estimateTokens } from '../../shared-kernel/text';
import { tokenize } from './embedding-providers';

// =======================================================================================
// Scripted fake: tests say exactly what the "model" does on each call.
// =======================================================================================

export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown>; id?: string }[];
  error?: LlmError;
}

/**
 * A test double for LlmProvider. Each streamTurn() consumes the next scripted turn;
 * generateObject() consumes the next scripted object for that purpose. Every request is
 * recorded so tests can assert what the orchestrator sent (tools offered, context included).
 */
export class ScriptedFakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly deterministic = true;
  readonly requests: LlmRequest[] = [];
  readonly objectRequests: LlmObjectRequest<unknown>[] = [];
  private readonly turns: ScriptedTurn[] = [];
  private readonly objects = new Map<LlmPurpose, (unknown | LlmError)[]>();

  constructor(private readonly fallbackObjects: Partial<Record<LlmPurpose, unknown>> = {}) {}

  modelFor(profile: ModelProfile): string {
    return `scripted-${profile}`;
  }

  enqueueTurns(...turns: ScriptedTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  enqueueObject(purpose: LlmPurpose, value: unknown): this {
    const queue = this.objects.get(purpose) ?? [];
    queue.push(value);
    this.objects.set(purpose, queue);
    return this;
  }

  get remainingTurns(): number {
    return this.turns.length;
  }

  async *streamTurn(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(structuredClone(request));
    const turn = this.turns.shift();
    if (!turn)
      throw new Error(`ScriptedFakeLlm: no scripted turn left for purpose "${request.purpose}"`);
    if (turn.error) throw turn.error;
    if (turn.text) {
      for (const piece of chunk(turn.text, 24)) yield { type: 'text', text: piece };
    }
    let counter = this.requests.length * 10;
    for (const call of turn.toolCalls ?? []) {
      counter += 1;
      yield {
        type: 'tool_call',
        call: { id: call.id ?? `call_${counter}`, name: call.name, input: call.input },
      };
    }
    yield {
      type: 'done',
      stopReason: turn.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: estimateRequest(request),
        outputTokens: estimateTokens(turn.text ?? '') + 8,
        estimated: true,
      },
      model: this.modelFor(request.profile),
    };
  }

  async generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResult<T>> {
    const { schema, ...rest } = request;
    this.objectRequests.push({ ...structuredClone(rest), schema } as LlmObjectRequest<unknown>);
    const queue = this.objects.get(request.purpose);
    const next = queue && queue.length > 0 ? queue.shift() : this.fallbackObjects[request.purpose];
    if (next instanceof LlmError) throw next;
    if (next === undefined)
      throw new Error(`ScriptedFakeLlm: no scripted object for purpose "${request.purpose}"`);
    return {
      object: request.schema.parse(next),
      usage: { inputTokens: estimateRequest(request), outputTokens: 20, estimated: true },
      model: this.modelFor(request.profile),
    };
  }
}

// =======================================================================================
// Heuristic fake: the offline demo model. Keyword routing + extractive answers with citations.
// =======================================================================================

interface ParsedSource {
  index: number;
  document: string;
  section: string;
  text: string;
}

interface PriorToolResult {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/i;
const ACTIVITY_ENTITIES = /\b(runs?|documents?|docs|conversations?|tool calls?|approvals?)\b/;

/**
 * A deterministic stand-in for a real model, so the whole product works without an API key
 * (and E2E tests are reproducible). It is NOT intelligent: it picks tools by keywords and
 * answers by extracting the source sentences that best overlap the question. The UI labels
 * its output "deterministic demo model".
 */
export class HeuristicFakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly deterministic = true;

  constructor(private readonly options: { streamDelayMs?: number } = {}) {}

  modelFor(profile: ModelProfile): string {
    return profile === 'fast' ? 'agentforge-demo-fast' : 'agentforge-demo';
  }

  async *streamTurn(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const available = new Set((request.tools ?? []).map((tool) => tool.name));
    const userText = extractRequestText(request.messages);
    const previous = priorToolResults(request.messages);
    const nextCall =
      request.purpose === 'act' ? chooseNextToolCall(userText, available, previous) : null;

    if (nextCall) {
      yield { type: 'tool_call', call: { ...nextCall, id: `call_${previous.length + 1}` } };
      yield {
        type: 'done',
        stopReason: 'tool_use',
        usage: { inputTokens: estimateRequest(request), outputTokens: 24, estimated: true },
        model: this.modelFor(request.profile),
      };
      return;
    }

    const answer = composeAnswer(userText, request, previous);
    for (const piece of chunk(answer, 18)) {
      if (signal.aborted) throw new LlmError('LLM_UNAVAILABLE', 'The request was cancelled', false);
      if (this.options.streamDelayMs) await sleep(this.options.streamDelayMs);
      yield { type: 'text', text: piece };
    }
    yield {
      type: 'done',
      stopReason: 'end_turn',
      usage: {
        inputTokens: estimateRequest(request),
        outputTokens: estimateTokens(answer),
        estimated: true,
      },
      model: this.modelFor(request.profile),
    };
  }

  async generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResult<T>> {
    const text = extractRequestText(request.messages);
    let value: unknown;
    switch (request.purpose) {
      case 'classify':
        value = classify(text);
        break;
      case 'plan':
        value = plan(text, request.system);
        break;
      case 'judge':
        value = {
          grounded: true,
          score: 1,
          reason: 'Deterministic judge: assumes grounded output.',
        };
        break;
      case 'title':
        value = { title: titleFrom(text) };
        break;
      case 'repair':
      case 'act':
        value = {};
        break;
    }
    return {
      object: request.schema.parse(value),
      usage: { inputTokens: estimateRequest(request), outputTokens: 24, estimated: true },
      model: this.modelFor(request.profile),
    };
  }
}

// ---------------------------------------------------------------------------------------
// Heuristics (exported for unit tests)
// ---------------------------------------------------------------------------------------

export function classify(text: string): {
  intent: string;
  needsKnowledge: boolean;
  riskFlags: string[];
} {
  const t = text.toLowerCase();
  if (
    /(ignore|disregard) (all |any |the )?(previous|prior|above) (instructions|rules)|reveal (your|the) (system )?prompt|jailbreak|developer mode|print your instructions/.test(
      t,
    )
  ) {
    return { intent: 'unsafe', needsKnowledge: false, riskFlags: ['prompt_injection'] };
  }
  if (
    /\b(password|api key|secret key|credit card)s? (of|for) (another|other|all) users?\b|\bexfiltrat/.test(
      t,
    )
  ) {
    return { intent: 'unsafe', needsKnowledge: false, riskFlags: ['data_exfiltration'] };
  }
  if (
    /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening)|yo)\b[\s!.?]*$/i.test(
      text.trim(),
    )
  ) {
    return { intent: 'chitchat', needsKnowledge: false, riskFlags: [] };
  }
  if (/\b(weather|stock price|lottery|horoscope|sports score)\b/.test(t)) {
    return { intent: 'out_of_scope', needsKnowledge: false, riskFlags: [] };
  }
  const computational =
    /\d+\s*[-+*/^]\s*\d+/.test(t) ||
    /\b(calculate|compute)\b/.test(t) ||
    /\d+(\.\d+)?\s*%\s*of\b/.test(t);
  const counting = /\b(how many|count|number of)\b/.test(t) && ACTIVITY_ENTITIES.test(t);
  const rate = /\b(completion|failure|success|error|approval)\s+rate\b/.test(t);
  const note =
    /\b(save|add|record|create|write)\s+(a\s+)?note\b|\bremember that\b|\bnote that\b/.test(t);
  const http = URL_PATTERN.test(text) || /\bhttp\b/.test(t);
  const about =
    /\b(what is this project|about this project|project (info|details|summary|overview))\b/.test(t);
  const task = computational || counting || rate || note || http || about;
  const mentionsDocs =
    /\b(doc|docs|document|runbook|policy|guide|handbook|playbook|according to|sla|procedure)\b/.test(
      t,
    );
  return {
    intent: task ? 'task' : 'question',
    needsKnowledge: !task || mentionsDocs,
    riskFlags: [],
  };
}

function plan(
  text: string,
  system: string,
): { goal: string; steps: { id: string; description: string; tool: string | null }[] } {
  const available = new Set(Array.from(system.matchAll(/- ([a-z_]+):/g), (m) => m[1]!));
  const steps: { id: string; description: string; tool: string | null }[] = [];
  const previous: PriorToolResult[] = [];
  for (let i = 0; i < 4; i += 1) {
    const call = chooseNextToolCall(text, available, previous);
    if (!call) break;
    steps.push({ id: `s${i + 1}`, description: describeCall(call), tool: call.name });
    previous.push({
      name: call.name,
      input: call.input,
      output: simulatedOutput(call),
      isError: false,
    });
  }
  steps.push({
    id: `s${steps.length + 1}`,
    description: 'Answer with the results, citing sources',
    tool: null,
  });
  return { goal: titleFrom(text), steps };
}

function describeCall(call: Omit<LlmToolCall, 'id'>): string {
  switch (call.name) {
    case 'calculator':
      return `Compute ${String(call.input.expression)}`;
    case 'project_query':
      return `Count ${String(call.input.entity).replace('_', ' ')}${call.input.status ? ` with status ${String(call.input.status)}` : ''}`;
    case 'http_request':
      return `${String(call.input.method ?? 'GET')} ${String(call.input.url)}`;
    case 'create_knowledge_note':
      return `Save a note: "${String(call.input.title)}" (needs approval)`;
    case 'knowledge_search':
      return `Search project knowledge for "${String(call.input.query)}"`;
    case 'project_metadata':
      return 'Look up project details';
    case 'document_lookup':
      return `Open document "${String(call.input.title)}"`;
    default:
      return call.name;
  }
}

function simulatedOutput(call: Omit<LlmToolCall, 'id'>): unknown {
  return call.name === 'project_query' ? { count: 1 } : {};
}

export function chooseNextToolCall(
  text: string,
  available: Set<string>,
  previous: PriorToolResult[],
): Omit<LlmToolCall, 'id'> | null {
  const t = text.toLowerCase();
  const used = (name: string) => previous.filter((p) => p.name === name);

  const noteMatch =
    /(?:save|add|record|create|write)\s+(?:a\s+)?note\s+(?:that\s+|saying\s+|about\s+)?(.+)|(?:remember|note)\s+that\s+(.+)/i.exec(
      text,
    );
  if (
    noteMatch &&
    available.has('create_knowledge_note') &&
    used('create_knowledge_note').length === 0
  ) {
    const content = (noteMatch[1] ?? noteMatch[2] ?? text).trim().replace(/[.!]+$/, '');
    const sentence = `${content.charAt(0).toUpperCase()}${content.slice(1)}`;
    return {
      name: 'create_knowledge_note',
      input: { title: titleFrom(sentence), content: `${sentence}.` },
    };
  }

  const url = URL_PATTERN.exec(text)?.[0];
  if (url && available.has('http_request') && used('http_request').length === 0) {
    const post = /\b(post|send|submit)\b/.test(t);
    return {
      name: 'http_request',
      input: post
        ? { method: 'POST', url, body: { text: text.replace(url, '').trim() } }
        : { method: 'GET', url },
    };
  }

  const wantsRate = /\b(rate|percent|percentage|ratio)\b/.test(t);
  const counting =
    (/\b(how many|count|number of)\b/.test(t) && ACTIVITY_ENTITIES.test(t)) ||
    (wantsRate && /\bruns?\b/.test(t));
  if (counting && available.has('project_query')) {
    const entity = /\bdocuments?\b/.test(t)
      ? 'documents'
      : /\bconversations?\b/.test(t)
        ? 'conversations'
        : /\btool calls?\b/.test(t)
          ? 'tool_calls'
          : /\bapprovals?\b/.test(t)
            ? 'approvals'
            : 'agent_runs';
    const since = /\btoday\b/.test(t) ? '24h' : /\bmonth\b/.test(t) ? '30d' : '7d';
    const status = /\bfail/.test(t)
      ? 'failed'
      : /\bcomplete|succe/.test(t)
        ? 'completed'
        : /\bpending\b/.test(t)
          ? 'pending'
          : /\bindexed\b/.test(t)
            ? 'indexed'
            : undefined;
    const queries = used('project_query');
    if (queries.length === 0) {
      return {
        name: 'project_query',
        input: { entity, aggregate: 'count', since, ...(status ? { status } : {}) },
      };
    }
    if (wantsRate && queries.length === 1 && status) {
      return { name: 'project_query', input: { entity, aggregate: 'count', since } };
    }
    if (
      wantsRate &&
      queries.length >= 2 &&
      available.has('calculator') &&
      used('calculator').length === 0
    ) {
      const [part, total] = queries.map((q) => countOf(q.output));
      if (part != null && total != null && total > 0) {
        return { name: 'calculator', input: { expression: `${part} / ${total} * 100` } };
      }
    }
    if (queries.length > 0) return null;
  }

  if (available.has('calculator') && used('calculator').length === 0) {
    const expression = extractExpression(text);
    if (expression) return { name: 'calculator', input: { expression } };
  }

  if (
    available.has('project_metadata') &&
    used('project_metadata').length === 0 &&
    /\b(what is this project|about this project|project (info|details|summary|overview))\b/.test(t)
  ) {
    return { name: 'project_metadata', input: {} };
  }

  const docMatch =
    /\b(?:open|show|summari[sz]e)\s+(?:the\s+)?(?:document|doc|file)\s+["“']?([^"”']+?)["”']?\s*$/i.exec(
      text.trim(),
    );
  if (docMatch && available.has('document_lookup') && used('document_lookup').length === 0) {
    return { name: 'document_lookup', input: { title: docMatch[1]!.trim() } };
  }
  return null;
}

function countOf(output: unknown): number | null {
  if (output && typeof output === 'object' && 'count' in output) {
    const value = Number((output as { count: unknown }).count);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function extractExpression(text: string): string | null {
  const percentOf = /(\d+(?:\.\d+)?)\s*%\s*of\s*(\d[\d,]*(?:\.\d+)?)/i.exec(text);
  if (percentOf) return `${percentOf[1]} / 100 * ${percentOf[2]!.replace(/,/g, '')}`;
  const candidates = text.match(/[-+*/^().\d\s,]{3,}/g) ?? [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/,/g, '').trim();
    if (/\d\s*[-+*/^]\s*[\d(]/.test(cleaned)) return cleaned;
  }
  return null;
}

function composeAnswer(userText: string, request: LlmRequest, previous: PriorToolResult[]): string {
  const parts: string[] = [];
  const intent = classify(userText).intent;

  // Structured-output agents: answer with a JSON value shaped by the schema in the prompt.
  const schemaMatch = /<output_schema>\s*([\s\S]*?)\s*<\/output_schema>/.exec(request.system);
  if (schemaMatch) {
    try {
      return JSON.stringify(
        synthesizeFromSchema(JSON.parse(schemaMatch[1]!) as JsonSchema, userText, ''),
        null,
        2,
      );
    } catch {
      // fall through to a plain answer
    }
  }

  if (intent === 'chitchat') {
    return "Hi! I'm this project's agent. Ask me about the project's documents, or give me a task such as a calculation, a lookup, or a note to save.";
  }

  for (const result of previous) {
    const out = (result.output ?? {}) as Record<string, unknown>;
    if (result.isError) {
      parts.push(
        `The ${result.name.replace(/_/g, ' ')} step failed (${String(out.message ?? out.error ?? 'error')}), so this answer may be incomplete.`,
      );
      continue;
    }
    switch (result.name) {
      case 'create_knowledge_note':
        if (out.approvalRequired) {
          parts.push(
            `Saving the note "${String(result.input.title)}" needs a person's approval first, so it was not saved in this evaluation run.`,
          );
        } else if (out.status === 'rejected' || out.status === 'expired' || out.denied) {
          parts.push(
            `I didn't save the note: the approval request was ${String(out.status ?? 'rejected')}${out.comment ? ` ("${String(out.comment)}")` : ''}.`,
          );
        } else {
          parts.push(
            `Saved the note "${String(out.title ?? result.input.title)}" to the project knowledge base. It becomes searchable once indexing finishes.`,
          );
        }
        break;
      case 'http_request':
        if (out.status === 'rejected' || out.denied) {
          parts.push('I did not send the request because it was not approved.');
        } else {
          parts.push(
            `${String(result.input.method ?? 'GET')} ${String(result.input.url)} returned HTTP ${String(out.status)}. ${summarizeBody(out.body)}`.trim(),
          );
        }
        break;
      case 'calculator': {
        const value = Number(out.result);
        const formatted = Number.isFinite(value)
          ? Number(value.toFixed(4)).toLocaleString('en-US')
          : String(out.result);
        const queries = previous.filter((p) => p.name === 'project_query');
        if (queries.length >= 2 && /\b(rate|percent|percentage)\b/i.test(userText)) {
          const [part, total] = queries.map((q) => countOf(q.output));
          parts.push(
            `The rate is ${formatted}% (${part} of ${total} ${String(queries[1]!.input.entity).replace('_', ' ')} in the last ${String(queries[1]!.input.since ?? '7d')}).`,
          );
        } else {
          parts.push(`${String(result.input.expression)} = ${formatted}`);
        }
        break;
      }
      case 'project_query':
        if (!previous.some((p) => p.name === 'calculator')) {
          const entity = String(result.input.entity).replace('_', ' ');
          const status = result.input.status ? `${String(result.input.status)} ` : '';
          parts.push(
            `There ${countOf(out) === 1 ? 'was' : 'were'} ${String(countOf(out) ?? out.count)} ${status}${entity} in the last ${String(result.input.since ?? '7d')}.`,
          );
        }
        break;
      case 'project_metadata':
        parts.push(
          `This is the "${String(out.name)}" project${out.description ? `: ${String(out.description)}` : ''}. ` +
            `It has ${String(out.documentCount ?? 0)} documents, ${String(out.agentCount ?? 0)} agents and ${String(out.memberCount ?? 0)} members.`,
        );
        break;
      default:
        break;
    }
  }

  const sources = collectSources(request.messages, previous);
  const wantsKnowledge = intent === 'question' || (!parts.length && intent === 'task');
  if (wantsKnowledge) {
    const extract = extractiveAnswer(userText, sources);
    if (extract) parts.push(extract);
    else if (parts.length === 0) {
      parts.push(
        "I couldn't find anything about that in this project's documents, so I won't guess. Upload the relevant document or rephrase the question.",
      );
    }
  }
  if (parts.length === 0) parts.push('Done.');
  return parts.join('\n\n');
}

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  minimum?: number;
}

const URGENT =
  /\b(urgent|outage|down|critical|asap|immediately|breach|cannot|can't|broken|sev ?1|p1)\b/i;

/** Deterministic value for a JSON Schema: enum values are picked by keyword, strings from the request. */
export function synthesizeFromSchema(schema: JsonSchema, text: string, key: string): unknown {
  if (schema.enum && schema.enum.length > 0) {
    const lowered = text.toLowerCase();
    const mentioned = schema.enum.find(
      (v) => typeof v === 'string' && lowered.includes(v.toLowerCase()),
    );
    if (mentioned !== undefined) return mentioned;
    if (/priority|severity|urgency/i.test(key)) {
      const high = schema.enum.find(
        (v) => typeof v === 'string' && /high|critical|urgent|p1|sev1/i.test(v),
      );
      const low = schema.enum.find((v) => typeof v === 'string' && /low|minor|p3|p4/i.test(v));
      if (URGENT.test(text) && high !== undefined) return high;
      if (low !== undefined) return schema.enum.includes('medium') ? 'medium' : low;
    }
    return schema.enum[0];
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type ?? (schema.properties ? 'object' : 'string')) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(schema.properties ?? {}))
        out[name] = synthesizeFromSchema(child, text, name);
      return out;
    }
    case 'array':
      return schema.items && (schema.minItems ?? 0) > 0
        ? [synthesizeFromSchema(schema.items, text, key)]
        : [];
    case 'number':
    case 'integer':
      return schema.minimum ?? 1;
    case 'boolean':
      return URGENT.test(text);
    default:
      return /reason|explanation|rationale/i.test(key)
        ? `Based on the request: ${titleFrom(text)}`
        : titleFrom(text);
  }
}

function summarizeBody(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body.slice(0, 200);
  if (typeof body === 'object') {
    const entries = Object.entries(body as Record<string, unknown>).slice(0, 4);
    return entries
      .map(
        ([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v)}`,
      )
      .join(', ');
  }
  return String(body);
}

function extractiveAnswer(question: string, sources: ParsedSource[]): string | null {
  if (sources.length === 0) return null;
  const questionTerms = new Set(tokenize(question));
  if (questionTerms.size === 0) return null;
  const scored: { sentence: string; index: number; score: number }[] = [];
  for (const source of sources.slice(0, 6)) {
    const sentences = source.text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+(?=[A-Z0-9`*"(])/)
      .map((s) => s.replace(/^[#>*\-\d.\s]+/, '').trim())
      .filter((s) => s.length > 25 && s.length < 400);
    for (const sentence of sentences) {
      const terms = tokenize(sentence);
      const overlap = new Set(terms.filter((term) => questionTerms.has(term))).size;
      // One shared word ("policy") is not evidence; require two when the question has two.
      if (overlap < Math.min(2, questionTerms.size)) continue;
      scored.push({ sentence, index: source.index, score: overlap / Math.sqrt(terms.length + 1) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked: typeof scored = [];
  for (const candidate of scored) {
    if (picked.length >= 3) break;
    if (picked.some((p) => p.sentence === candidate.sentence)) continue;
    picked.push(candidate);
  }
  if (picked.length === 0) return null;
  const best = picked[0]!.score;
  const lines = picked.filter((p) => p.score >= best * 0.45);
  return lines.map((p) => `${p.sentence.replace(/[.!?]?$/, '.')} [${p.index}]`).join(' ');
}

function collectSources(messages: LlmMessage[], previous: PriorToolResult[]): ParsedSource[] {
  const sources = new Map<number, ParsedSource>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const match of message.content.matchAll(
      /<source index="(\d+)" document="([^"]*)"(?: section="([^"]*)")?[^>]*>([\s\S]*?)<\/source>/g,
    )) {
      const index = Number(match[1]);
      sources.set(index, {
        index,
        document: match[2]!,
        section: match[3] ?? '',
        text: match[4]!.trim(),
      });
    }
  }
  for (const result of previous) {
    if ((result.name !== 'knowledge_search' && result.name !== 'document_lookup') || result.isError)
      continue;
    type Passage = {
      sourceIndex: number;
      documentTitle: string;
      headingPath: string;
      content: string;
    };
    const output = result.output as { results?: Passage[]; passages?: Passage[] } | null;
    const results = [...(output?.results ?? []), ...(output?.passages ?? [])];
    for (const r of results) {
      if (!sources.has(r.sourceIndex)) {
        sources.set(r.sourceIndex, {
          index: r.sourceIndex,
          document: r.documentTitle,
          section: r.headingPath,
          text: r.content,
        });
      }
    }
  }
  return [...sources.values()];
}

export function extractRequestText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const tagged = /<request>([\s\S]*?)<\/request>/.exec(message.content);
    return (tagged ? tagged[1]! : message.content).trim();
  }
  return '';
}

function priorToolResults(messages: LlmMessage[]): PriorToolResult[] {
  const calls = new Map<string, LlmToolCall>();
  const results: PriorToolResult[] = [];
  for (const message of messages) {
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role === 'tool') {
      const call = calls.get(message.toolCallId);
      let output: unknown = message.content;
      try {
        output = JSON.parse(message.content);
      } catch {
        // plain text result
      }
      results.push({
        name: message.toolName,
        input: call?.input ?? {},
        output,
        isError: Boolean(message.isError),
      });
    }
  }
  return results;
}

function titleFrom(text: string): string {
  const clean = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = clean.split(' ').slice(0, 9).join(' ');
  return words.length > 60 ? `${words.slice(0, 59)}…` : words || 'Untitled';
}

function chunk(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

function estimateRequest(request: { system: string; messages: LlmMessage[] }): number {
  return (
    estimateTokens(request.system) +
    request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
