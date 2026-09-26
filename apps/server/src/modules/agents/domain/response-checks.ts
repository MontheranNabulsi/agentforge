/**
 * Deterministic checks on a final answer. The validator runs these; they are pure so each
 * rule has a unit test.
 */

/** [1], [2] … citation markers in the order they first appear. */
export function citedIndices(text: string): number[] {
  const seen: number[] = [];
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const index = Number(match[1]);
    if (!seen.includes(index)) seen.push(index);
  }
  return seen;
}

/** Removes markers that point at sources the run never retrieved (a common hallucination). */
export function stripUnknownCitations(
  text: string,
  known: ReadonlySet<number>,
): { text: string; removed: number[] } {
  const removed: number[] = [];
  const cleaned = text.replace(/\s?\[(\d{1,3})\]/g, (marker, raw: string) => {
    const index = Number(raw);
    if (known.has(index)) return marker;
    if (!removed.includes(index)) removed.push(index);
    return '';
  });
  return { text: cleaned, removed };
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
];

/** Redacts credential-shaped strings before an answer is stored or shown. */
export function redactSecrets(text: string): { text: string; found: string[] } {
  const found: string[] = [];
  let result = text;
  for (const [name, pattern] of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      if (!found.includes(name)) found.push(name);
      return '[redacted]';
    });
  }
  return { text: result, found };
}

/** Pulls a JSON value out of a model answer (bare JSON or a ```json fence). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error('No JSON found');
  return JSON.parse(candidate.slice(start));
}

const REFUSAL_PATTERN =
  /\b(i can(?:'|no)t help with|i won'?t|i'm not able to|outside what i can help|i cannot assist)\b/i;
export const looksLikeRefusal = (text: string) => REFUSAL_PATTERN.test(text);
