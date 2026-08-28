/**
 * Local-only ambient declarations for the Node built-ins this project uses.
 *
 * This file exists so `tsconfig.check.json` can type-check the source in an
 * environment where `@types/node` is not installed. It is NOT part of the
 * build: tsconfig.json (used by `npm run build`) excludes it and relies on the
 * real `@types/node` from node_modules. Delete it once dependencies install.
 */
declare module 'node:crypto' {
  export function randomBytes(size: number): Buffer;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function createHash(alg: string): { update(d: Uint8Array | string, enc?: string): any; digest(): Buffer; digest(enc: string): string };
  export function createHmac(alg: string, key: string | Uint8Array): { update(d: Uint8Array | string, enc?: string): any; digest(): Buffer; digest(enc: string): string };
  export function scrypt(
    password: string | Buffer, salt: Buffer, keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
    cb: (err: Error | null, key: Buffer) => void,
  ): void;
}
declare module 'node:util' {
  export function promisify<T extends (...a: any[]) => any>(fn: T): (...a: any[]) => Promise<any>;
}
declare module 'node:fs' { export function existsSync(p: string): boolean; }
declare module 'node:fs/promises' {
  export function readdir(p: string): Promise<string[]>;
  export function readFile(p: string, enc: string): Promise<string>;
}
declare module 'node:path' {
  export function join(...p: string[]): string;
  export function dirname(p: string): string;
}
declare module 'node:url' { export function fileURLToPath(u: string | URL): string; }
declare module 'node:module' { export function register(s: string, parent?: string | URL): void; }
declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}
declare module 'node:assert/strict' {
  interface A {
    (v: unknown, m?: string): void;
    equal(a: unknown, b: unknown, m?: string): void;
    notEqual(a: unknown, b: unknown, m?: string): void;
    deepEqual(a: unknown, b: unknown, m?: string): void;
    notDeepEqual(a: unknown, b: unknown, m?: string): void;
    match(a: string, re: RegExp, m?: string): void;
    ok(v: unknown, m?: string): void;
    throws(fn: () => unknown, m?: unknown): void;
  }
  const assert: A;
  export default assert;
}
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
};
declare const console: { log(...a: unknown[]): void; error(...a: unknown[]): void };
declare namespace NodeJS { type ProcessEnv = Record<string, string | undefined>; }
interface Buffer extends Uint8Array {
  toString(enc?: string): string;
  equals(other: Uint8Array): boolean;
  readonly length: number;
}
declare const Buffer: {
  from(v: string | ArrayBufferLike | Uint8Array, enc?: string): Buffer;
  concat(list: readonly Uint8Array[]): Buffer;
};
interface ImportMeta { url: string }

/** Minimal `pg` surface used by src/db/pool.ts (real types ship with the package). */
declare module 'pg' {
  interface QueryResultLike { rows: any[]; rowCount: number | null }
  class Pool {
    constructor(config: Record<string, unknown>);
    query(text: string, params?: unknown[]): Promise<QueryResultLike>;
    connect(): Promise<{ query(text: string, params?: unknown[]): Promise<QueryResultLike>; release(): void }>;
    end(): Promise<void>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
