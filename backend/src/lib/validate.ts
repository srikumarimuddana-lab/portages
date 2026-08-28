/**
 * Minimal strict schema validation, dependency-free.
 *
 * Zod is the production choice for this project and the API below is
 * deliberately shaped like it, so swapping is mechanical. This exists so the
 * validation layer — which is a security boundary, not a convenience — has no
 * supply-chain dependency and can be unit-tested in any environment.
 *
 * Strictness rules, all deliberate:
 *  - Unknown object keys are REJECTED, never silently dropped. Mass-assignment
 *    is the bug class this prevents.
 *  - Type coercion is opt-in per field, never implicit.
 *  - Every string has a maximum length; unbounded input is a DoS surface.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface Schema<T> {
  parse(input: unknown, path?: string): Result<T>;
}

const fail = (path: string, msg: string): Result<never> => ({
  ok: false,
  errors: [`${path || 'value'}: ${msg}`],
});

export interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
  lowercase?: boolean;
}

export function string(opts: StringOpts = {}): Schema<string> {
  const max = opts.max ?? 1000; // bounded by default
  return {
    parse(input, path = '') {
      if (typeof input !== 'string') return fail(path, 'must be a string');
      let v = opts.trim === false ? input : input.trim();
      if (opts.lowercase) v = v.toLowerCase();
      // Reject control characters (except tab/newline) — they have no place in
      // user input and are a classic log-injection and display-spoofing vector.
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) {
        return fail(path, 'contains control characters');
      }
      if (opts.min !== undefined && v.length < opts.min) {
        return fail(path, `must be at least ${opts.min} characters`);
      }
      if (v.length > max) return fail(path, `must be at most ${max} characters`);
      if (opts.pattern && !opts.pattern.test(v)) return fail(path, 'has invalid format');
      return { ok: true, value: v };
    },
  };
}

// Deliberately conservative. Full RFC 5322 is not worth the attack surface.
const EMAIL_RE = /^[^\s@,;:<>"'\\]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function email(): Schema<string> {
  const base = string({ max: 254, lowercase: true, pattern: EMAIL_RE });
  return {
    parse(input, path = '') {
      const r = base.parse(input, path);
      if (!r.ok) return fail(path, 'must be a valid email address');
      return r;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuid(): Schema<string> {
  return {
    parse(input, path = '') {
      if (typeof input !== 'string' || !UUID_RE.test(input)) {
        return fail(path, 'must be a UUID');
      }
      return { ok: true, value: input.toLowerCase() };
    },
  };
}

export interface IntOpts {
  min?: number;
  max?: number;
  coerce?: boolean;
}

export function integer(opts: IntOpts = {}): Schema<number> {
  return {
    parse(input, path = '') {
      let v = input;
      if (opts.coerce && typeof v === 'string' && v.trim() !== '') v = Number(v);
      if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isSafeInteger(v)) {
        return fail(path, 'must be an integer');
      }
      if (opts.min !== undefined && v < opts.min) return fail(path, `must be >= ${opts.min}`);
      if (opts.max !== undefined && v > opts.max) return fail(path, `must be <= ${opts.max}`);
      return { ok: true, value: v };
    },
  };
}

export function number(opts: IntOpts = {}): Schema<number> {
  return {
    parse(input, path = '') {
      let v = input;
      if (opts.coerce && typeof v === 'string' && v.trim() !== '') v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(path, 'must be a number');
      if (opts.min !== undefined && v < opts.min) return fail(path, `must be >= ${opts.min}`);
      if (opts.max !== undefined && v > opts.max) return fail(path, `must be <= ${opts.max}`);
      return { ok: true, value: v };
    },
  };
}

export function boolean(opts: { coerce?: boolean } = {}): Schema<boolean> {
  return {
    parse(input, path = '') {
      if (typeof input === 'boolean') return { ok: true, value: input };
      if (opts.coerce) {
        if (input === 'true') return { ok: true, value: true };
        if (input === 'false') return { ok: true, value: false };
      }
      return fail(path, 'must be a boolean');
    },
  };
}

export function enumOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return {
    parse(input, path = '') {
      if (typeof input !== 'string' || !values.includes(input)) {
        return fail(path, `must be one of: ${values.join(', ')}`);
      }
      return { ok: true, value: input as T[number] };
    },
  };
}

export function array<T>(item: Schema<T>, opts: { max?: number } = {}): Schema<T[]> {
  const max = opts.max ?? 100;
  return {
    parse(input, path = '') {
      if (!Array.isArray(input)) return fail(path, 'must be an array');
      if (input.length > max) return fail(path, `must have at most ${max} items`);
      const out: T[] = [];
      const errors: string[] = [];
      input.forEach((el, i) => {
        const r = item.parse(el, `${path}[${i}]`);
        if (r.ok) out.push(r.value);
        else errors.push(...r.errors);
      });
      return errors.length ? { ok: false, errors } : { ok: true, value: out };
    },
  };
}

export function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  return {
    parse(input, path = '') {
      if (input === undefined || input === null) return { ok: true, value: undefined };
      return inner.parse(input, path) as Result<T | undefined>;
    },
  };
}

type Shape = Record<string, Schema<unknown>>;
type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Schema<infer U> ? U : never };

/**
 * Object schema. Unknown keys are an error — this is the mass-assignment
 * guard. Prototype-polluting keys are rejected before anything else.
 */
export function object<S extends Shape>(shape: S): Schema<Infer<S>> {
  const known = new Set(Object.keys(shape));
  return {
    parse(input, path = '') {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return fail(path, 'must be an object');
      }
      const src = input as Record<string, unknown>;
      const errors: string[] = [];
      for (const key of Object.keys(src)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          return fail(path ? `${path}.${key}` : key, 'illegal property name');
        }
        if (!known.has(key)) {
          errors.push(`${path ? `${path}.${key}` : key}: unknown field`);
        }
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const [key, schema] of Object.entries(shape)) {
        const child = path ? `${path}.${key}` : key;
        const r = schema.parse(Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined, child);
        if (r.ok) {
          if (r.value !== undefined) out[key] = r.value;
        } else {
          errors.push(...r.errors);
        }
      }
      return errors.length ? { ok: false, errors } : { ok: true, value: out as Infer<S> };
    },
  };
}
