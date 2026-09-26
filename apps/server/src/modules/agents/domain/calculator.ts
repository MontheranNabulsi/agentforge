/**
 * A small arithmetic evaluator for the calculator tool: a recursive-descent parser, not eval().
 * Grammar (precedence low → high):
 *   expr   := term (('+' | '-') term)*
 *   term   := power (('*' | '/' | '%') power)*
 *   power  := unary ('^' power)?          (right-associative)
 *   unary  := ('-' | '+') unary | call
 *   call   := IDENT '(' args ')' | primary
 *   primary:= NUMBER | CONST | '(' expr ')'
 */

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (x, digits = 0) => Number(x.toFixed(Math.max(0, Math.min(10, digits)))),
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export class CalculatorError extends Error {}

type Token =
  { type: 'num'; value: number } | { type: 'id'; value: string } | { type: 'op'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
    } else if (/[0-9.]/.test(ch)) {
      const match =
        /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(input.slice(i)) ?? /^\d+\.?/.exec(input.slice(i));
      if (!match) throw new CalculatorError(`Unexpected character "${ch}"`);
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
    } else if (/[a-z]/i.test(ch)) {
      const match = /^[a-z]+/i.exec(input.slice(i))!;
      tokens.push({ type: 'id', value: match[0].toLowerCase() });
      i += match[0].length;
    } else if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
    } else {
      throw new CalculatorError(`Unexpected character "${ch}"`);
    }
  }
  return tokens;
}

export function evaluateExpression(input: string): number {
  if (input.length > 200) throw new CalculatorError('Expression too long (200 characters max)');
  const tokens = tokenize(
    input
      .replace(/,(?=\d{3}\b)/g, '')
      .replace(/×/g, '*')
      .replace(/÷/g, '/'),
  );
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expectOp = (value: string) => {
    const token = take();
    if (!token || token.type !== 'op' || token.value !== value)
      throw new CalculatorError(`Expected "${value}"`);
  };

  const expr = (): number => {
    if (++depth > 50) throw new CalculatorError('Expression nested too deeply');
    let value = term();
    for (let t = peek(); t?.type === 'op' && (t.value === '+' || t.value === '-'); t = peek()) {
      take();
      value = t.value === '+' ? value + term() : value - term();
    }
    depth -= 1;
    return value;
  };
  const term = (): number => {
    let value = power();
    for (let t = peek(); t?.type === 'op' && ['*', '/', '%'].includes(t.value); t = peek()) {
      take();
      const right = power();
      if ((t.value === '/' || t.value === '%') && right === 0)
        throw new CalculatorError('Division by zero');
      value = t.value === '*' ? value * right : t.value === '/' ? value / right : value % right;
    }
    return value;
  };
  const power = (): number => {
    const base = unary();
    const t = peek();
    if (t?.type === 'op' && t.value === '^') {
      take();
      return base ** power();
    }
    return base;
  };
  const unary = (): number => {
    const t = peek();
    if (t?.type === 'op' && (t.value === '-' || t.value === '+')) {
      take();
      return t.value === '-' ? -unary() : unary();
    }
    return call();
  };
  const call = (): number => {
    const t = peek();
    if (t?.type === 'id') {
      take();
      if (t.value in CONSTANTS && peek()?.value !== '(') return CONSTANTS[t.value]!;
      const fn = FUNCTIONS[t.value];
      if (!fn) throw new CalculatorError(`Unknown function "${t.value}"`);
      expectOp('(');
      const args = [expr()];
      while (peek()?.type === 'op' && peek()?.value === ',') {
        take();
        args.push(expr());
      }
      expectOp(')');
      return fn(...args);
    }
    return primary();
  };
  const primary = (): number => {
    const t = take();
    if (!t) throw new CalculatorError('Unexpected end of expression');
    if (t.type === 'num') return t.value;
    if (t.type === 'op' && t.value === '(') {
      const value = expr();
      expectOp(')');
      return value;
    }
    throw new CalculatorError(`Unexpected "${t.value}"`);
  };

  if (tokens.length === 0) throw new CalculatorError('Empty expression');
  const result = expr();
  if (pos < tokens.length) throw new CalculatorError(`Unexpected "${String(tokens[pos]!.value)}"`);
  if (!Number.isFinite(result)) throw new CalculatorError('The result is not a finite number');
  return result;
}
