import { describe, expect, it } from 'vitest';
import {
  citedIndices,
  extractJson,
  looksLikeRefusal,
  redactSecrets,
  stripUnknownCitations,
} from '../../src/modules/agents/domain/response-checks';

describe('response checks', () => {
  it('finds citations in order of first appearance', () => {
    expect(citedIndices('A [2] b [1] c [2]')).toEqual([2, 1]);
  });

  it('removes citations to sources that were never retrieved', () => {
    const result = stripUnknownCitations('Refunds take 30 days [1][7].', new Set([1]));
    expect(result.text).toBe('Refunds take 30 days [1].');
    expect(result.removed).toEqual([7]);
  });

  it('redacts credential-shaped strings', () => {
    const { text, found } = redactSecrets(
      'key sk-ant-abcdefghijklmnopqrstuvwxyz123 and AKIAABCDEFGHIJKLMNOP',
    );
    expect(text).not.toContain('sk-ant-');
    expect(found).toEqual(expect.arrayContaining(['anthropic_key', 'aws_access_key']));
  });

  it('extracts JSON from fenced or bare answers', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"b":[1,2]}')).toEqual({ b: [1, 2] });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('recognises refusals', () => {
    expect(looksLikeRefusal("I can't help with that.")).toBe(true);
    expect(looksLikeRefusal('Refunds take 30 days.')).toBe(false);
  });
});
