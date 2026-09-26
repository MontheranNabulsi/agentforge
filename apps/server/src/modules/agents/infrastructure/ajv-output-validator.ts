import { Ajv, type ValidateFunction } from 'ajv';
import type { OutputSchemaValidator } from '../application/ports';

/** JSON Schema validation for structured-output agents (draft 2020-12 subset Ajv supports by default). */
export class AjvOutputValidator implements OutputSchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly cache = new Map<string, ValidateFunction>();

  private compile(schema: Record<string, unknown>): ValidateFunction {
    const key = JSON.stringify(schema);
    let fn = this.cache.get(key);
    if (!fn) {
      const { $schema: _ignored, ...rest } = schema;
      fn = this.ajv.compile(rest);
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, fn);
    }
    return fn;
  }

  check(schema: Record<string, unknown>): string | null {
    try {
      this.compile(schema);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'invalid schema';
    }
  }

  validate(schema: Record<string, unknown>, value: unknown): { valid: boolean; errors: string[] } {
    const fn = this.compile(schema);
    const valid = fn(value) === true;
    return {
      valid,
      errors: valid
        ? []
        : (fn.errors ?? [])
            .slice(0, 8)
            .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`),
    };
  }
}
