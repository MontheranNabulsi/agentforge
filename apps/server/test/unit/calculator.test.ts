import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../../src/modules/agents/domain/calculator';

describe('calculator', () => {
  it.each([
    ['1840 * 0.15', 276],
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['2 ^ 3 ^ 2', 512],
    ['-3 + 5', 2],
    ['sqrt(16) + max(1, 7, 3)', 11],
    ['round(pi, 2)', 3.14],
    ['10 % 4', 2],
  ])('%s = %d', (expression, expected) => {
    expect(evaluateExpression(expression)).toBeCloseTo(expected, 10);
  });

  it.each(['process.exit(1)', 'constructor', '1 +', '2 / 0', 'alert(1)', '9'.repeat(400)])(
    'rejects %s',
    (expression) => {
      expect(() => evaluateExpression(expression)).toThrow();
    },
  );
});
