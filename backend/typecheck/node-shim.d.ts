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
    rejects(fn: () => Promise<unknown>, m?: unknown): Promise<void>;
    fail(m?: string): never;
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
  copy(target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  subarray(begin?: number, end?: number): Buffer;
  readonly length: number;
}
declare const Buffer: {
  from(v: string | ArrayBufferLike | Uint8Array | readonly number[], enc?: string): Buffer;
  concat(list: readonly Uint8Array[]): Buffer;
  alloc(size: number, fill?: number): Buffer;
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

/**
 * Web-standard globals. Node 18+ provides these at runtime and `@types/node`
 * declares them, so this block is only needed for offline type-checking.
 */
interface Headers {
  get(name: string): string | null;
  set(name: string, value: string): void;
  append(name: string, value: string): void;
  forEach(cb: (value: string, key: string) => void): void;
  getSetCookie?(): string[];
}
declare const Headers: { new (init?: Record<string, string> | Headers): Headers };

interface ReadableStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?(): void;
}
interface ReadableStreamLike { getReader(): ReadableStreamReader }

interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: ReadableStreamLike | null;
}
declare const Request: {
  new (input: string, init?: {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: string;
  }): Request;
};

interface Response {
  readonly status: number;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare const Response: {
  new (body?: string | null, init?: { status?: number; headers?: Headers }): Response;
};

declare const TextDecoder: {
  new (label?: string, opts?: { fatal?: boolean }): { decode(input?: Uint8Array): string };
};
interface URLSearchParams { get(name: string): string | null }
interface URL {
  readonly searchParams: URLSearchParams;
  readonly pathname: string;
  toString(): string;
}
declare const URL: { new (url: string, base?: string): URL };

declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare module 'node:crypto' {
  interface KeyObject {
    readonly asymmetricKeyType?: string;
    export(opts: { type: string; format: string }): string | Buffer;
  }
  export function createPrivateKey(key: string | Buffer): KeyObject;
  export function createSign(alg: string): { update(d: string): { sign(key: KeyObject): Buffer } };
  export function createVerify(alg: string): { update(d: string): { verify(key: KeyObject, sig: Buffer): boolean } };
  export function generateKeyPairSync(
    type: string,
    opts: Record<string, unknown>,
  ): { privateKey: KeyObject; publicKey: KeyObject };
}

/** node:http surface used by src/index.ts (the local dev server). */
declare module 'node:http' {
  export interface IncomingMessage extends AsyncIterable<unknown> {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
  }
  export interface ServerResponse {
    headersSent: boolean;
    writeHead(status: number, headers?: Record<string, string | string[]>): void;
    end(body?: string): void;
  }
  export interface Server {
    listen(port: number, cb?: () => void): void;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare function setTimeout(cb: (...a: unknown[]) => void, ms: number): unknown;
