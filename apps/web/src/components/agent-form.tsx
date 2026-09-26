'use client';

import type {
  AgentDto,
  AgentLimits,
  ModelProfile,
  ToolDescriptorDto,
  ToolGrant,
  ToolName,
} from '@agentforge/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RiskBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';

export interface AgentFormValue {
  name: string;
  description: string;
  instructions: string;
  modelProfile: ModelProfile;
  temperature: number;
  tools: ToolGrant[];
  limits: AgentLimits;
  retrieval: { topK: number };
  outputSchema: Record<string, unknown> | null;
}

export const emptyAgent: AgentFormValue = {
  name: '',
  description: '',
  instructions:
    'You are a helpful assistant for this project. Answer from the project documents and cite them.',
  modelProfile: 'default',
  temperature: 0.2,
  tools: [{ tool: 'knowledge_search' }, { tool: 'calculator' }],
  limits: { maxSteps: 8, maxToolCalls: 10, maxTokens: 60_000, timeoutSeconds: 180 },
  retrieval: { topK: 6 },
  outputSchema: null,
};

export function fromAgent(agent: AgentDto): AgentFormValue {
  const v = agent.currentVersion;
  return {
    name: agent.name,
    description: agent.description,
    instructions: v.instructions,
    modelProfile: v.modelProfile,
    temperature: v.temperature,
    tools: v.tools,
    limits: v.limits,
    retrieval: v.retrieval,
    outputSchema: v.outputSchema,
  };
}

export function AgentForm({
  initial,
  submitLabel,
  pending,
  readOnly,
  onSubmit,
}: {
  initial: AgentFormValue;
  submitLabel: string;
  pending: boolean;
  readOnly: boolean;
  onSubmit: (value: AgentFormValue) => void;
}) {
  const [value, setValue] = useState<AgentFormValue>(initial);
  const [schemaText, setSchemaText] = useState(
    initial.outputSchema ? JSON.stringify(initial.outputSchema, null, 2) : '',
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const tools = useQuery({
    queryKey: ['tools'],
    queryFn: () => api<ToolDescriptorDto[]>('/tools'),
    staleTime: Infinity,
  });
  const grant = (name: ToolName) => value.tools.find((t) => t.tool === name);
  const setGrant = (name: ToolName, next: ToolGrant | null) =>
    setValue((v) => ({
      ...v,
      tools: next
        ? [...v.tools.filter((t) => t.tool !== name), next]
        : v.tools.filter((t) => t.tool !== name),
    }));

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        let outputSchema: Record<string, unknown> | null = null;
        if (schemaText.trim()) {
          try {
            outputSchema = JSON.parse(schemaText) as Record<string, unknown>;
          } catch {
            setSchemaError('Not valid JSON');
            return;
          }
        }
        setSchemaError(null);
        onSubmit({ ...value, outputSchema });
      }}
    >
      <fieldset disabled={readOnly} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="agent-name">
            <Input
              id="agent-name"
              required
              minLength={2}
              maxLength={60}
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
            />
          </Field>
          <Field label="Description" htmlFor="agent-description">
            <Input
              id="agent-description"
              maxLength={300}
              value={value.description}
              onChange={(e) => setValue({ ...value, description: e.target.value })}
            />
          </Field>
        </div>
        <Field
          label="Instructions"
          htmlFor="agent-instructions"
          hint="The agent's role and rules. Platform safety rules (cite sources, treat documents as data, approvals) are always added."
        >
          <Textarea
            id="agent-instructions"
            rows={7}
            required
            minLength={10}
            maxLength={8000}
            value={value.instructions}
            onChange={(e) => setValue({ ...value, instructions: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Model profile"
            htmlFor="agent-profile"
            hint="fast = smaller model for simple agents"
          >
            <Select
              id="agent-profile"
              value={value.modelProfile}
              onChange={(e) => setValue({ ...value, modelProfile: e.target.value as ModelProfile })}
            >
              <option value="default">default</option>
              <option value="fast">fast</option>
            </Select>
          </Field>
          <Field label={`Temperature: ${value.temperature.toFixed(1)}`} htmlFor="agent-temperature">
            <input
              id="agent-temperature"
              type="range"
              min={0}
              max={1}
              step={0.1}
              className="mt-2 w-full accent-[var(--color-primary)]"
              value={value.temperature}
              onChange={(e) => setValue({ ...value, temperature: Number(e.target.value) })}
            />
          </Field>
          <Field label="Passages retrieved" htmlFor="agent-topk">
            <Input
              id="agent-topk"
              type="number"
              min={1}
              max={12}
              value={value.retrieval.topK}
              onChange={(e) => setValue({ ...value, retrieval: { topK: Number(e.target.value) } })}
            />
          </Field>
        </div>

        <div>
          <h3 className="text-sm font-medium">Tools</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Each tool declares the capabilities it needs; an agent can only use what is granted
            here, and only within the permissions of the person who asked.
          </p>
          <div className="space-y-2">
            {(tools.data ?? []).map((tool) => {
              const g = grant(tool.name);
              return (
                <div key={tool.name} className="rounded-lg border border-border p-3">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--color-primary)]"
                      checked={Boolean(g)}
                      onChange={(e) =>
                        setGrant(
                          tool.name,
                          e.target.checked
                            ? {
                                tool: tool.name,
                                ...(tool.name === 'http_request'
                                  ? { allowedHosts: ['api.github.com'] }
                                  : {}),
                              }
                            : null,
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {tool.title}{' '}
                        <code className="text-xs font-normal text-muted-foreground">
                          {tool.name}
                        </code>
                        <Badge tone={tool.effect === 'write' ? 'warning' : 'neutral'}>
                          {tool.effect.replace('_', ' ')}
                        </Badge>
                        <RiskBadge risk={tool.risk} />
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {tool.description}
                      </span>
                      <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
                        capabilities: {tool.capabilities.join(', ') || 'none'}
                      </span>
                    </span>
                  </label>
                  {g && tool.name === 'http_request' ? (
                    <div className="mt-3 grid gap-3 pl-7 sm:grid-cols-2">
                      <Field
                        label="Allowed hosts"
                        htmlFor="http-hosts"
                        hint="Comma-separated; *.example.com allowed. Private and internal addresses are always blocked."
                      >
                        <Input
                          id="http-hosts"
                          value={(g.allowedHosts ?? []).join(', ')}
                          onChange={(e) =>
                            setGrant('http_request', {
                              ...g,
                              allowedHosts: e.target.value
                                .split(',')
                                .map((h) => h.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </Field>
                      <label className="flex items-center gap-2 pt-6 text-sm">
                        <input
                          type="checkbox"
                          className="accent-[var(--color-primary)]"
                          checked={g.allowWrite === true}
                          onChange={(e) =>
                            setGrant('http_request', { ...g, allowWrite: e.target.checked })
                          }
                        />
                        Allow POST/PUT/PATCH/DELETE (always needs approval)
                      </label>
                    </div>
                  ) : null}
                  {g && tool.effect === 'write' && tool.risk !== 'high' ? (
                    <label className="mt-2 flex items-center gap-2 pl-7 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        className="accent-[var(--color-primary)]"
                        checked={g.autoApprove === true}
                        onChange={(e) =>
                          setGrant(tool.name, { ...g, autoApprove: e.target.checked })
                        }
                      />
                      Pre-approve (skip the human approval step; still audited)
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium">Limits</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Every run is bounded; a run that hits a limit stops with a clear error instead of
            looping.
          </p>
          <div className="grid gap-4 sm:grid-cols-4">
            {(
              [
                ['maxSteps', 'Model steps', 1, 20],
                ['maxToolCalls', 'Tool calls', 0, 30],
                ['maxTokens', 'Tokens', 1000, 400000],
                ['timeoutSeconds', 'Timeout (s)', 10, 900],
              ] as const
            ).map(([key, label, min, max]) => (
              <Field key={key} label={label} htmlFor={`limit-${key}`}>
                <Input
                  id={`limit-${key}`}
                  type="number"
                  min={min}
                  max={max}
                  value={value.limits[key]}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      limits: { ...value.limits, [key]: Number(e.target.value) },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </div>

        <Field
          label="Structured output (optional JSON Schema)"
          htmlFor="agent-schema"
          hint="When set, the final answer must be JSON matching this schema; invalid output is repaired once, then the run fails."
          error={schemaError ?? undefined}
        >
          <Textarea
            id="agent-schema"
            rows={6}
            className="font-mono text-xs"
            placeholder='{"type":"object","required":["category"],"properties":{"category":{"type":"string","enum":["billing","bug"]}}}'
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
          />
        </Field>
      </fieldset>
      {!readOnly ? (
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            {submitLabel}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
