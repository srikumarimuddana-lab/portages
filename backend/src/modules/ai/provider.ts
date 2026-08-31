/**
 * The model seam.
 *
 * Every AI feature in Portage talks to this interface and nothing else. The
 * Vercel AI SDK, the Anthropic SDK and the raw HTTP adapter are all just
 * implementations of it, which is what makes the choice reversible: swapping
 * providers is one line in the composition root, not a rewrite of three
 * features.
 *
 * That is the same shape used for `NotificationChannel`, `AddressResolver`
 * and `Sql` elsewhere in this codebase, and for the same reason — but here it
 * carries more weight than usual, because of a constraint worth stating
 * plainly:
 *
 *   npm is blocked by policy in the build environment this was written in, so
 *   neither `ai` (the Vercel AI SDK) nor `@anthropic-ai/sdk` can be installed
 *   or run here. `adapters/anthropic-http.ts` therefore speaks the Messages
 *   API over `fetch` with nothing but Node's standard library — the same
 *   approach this project already takes for AWS SigV4 and JWKS verification —
 *   and it works today. `adapters/vercel-ai.ts` is the AI SDK adapter and
 *   becomes the default the moment `npm install` is available.
 *
 * Both satisfy this interface, so the features do not know or care which one
 * is wired in, and the tests use a third implementation that never leaves the
 * process.
 */

/**
 * The tasks AI is allowed to be used for.
 *
 * A closed set rather than a free string, because every one of these is also
 * a kill switch key, a budget line and an audit subject. A task that is not
 * on this list has no switch, no budget and no record, and must not exist.
 */
export const AI_TASKS = ['chat_search', 'listing_builder', 'moderation'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** The kill switch guarding each task. Mirrors modules/flags/registry.ts. */
export const TASK_FLAG = {
  chat_search: 'ai.chat_search',
  listing_builder: 'ai.listing_builder',
  moderation: 'ai.moderation',
} as const;

export interface CompletionMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  task: AiTask;
  /** Trusted instructions. Never contains user or listing text — see sanitize.ts. */
  system: string;
  messages: CompletionMessage[];
  /**
   * A JSON Schema the reply must satisfy. Set for every task in this codebase:
   * prose is not a thing any of our features actually want back from a model.
   */
  jsonSchema?: Record<string, unknown> | undefined;
  maxTokens: number;
  model: string;
  /** Thinking depth and token spend. Omitted means the API default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  /** Cancels the request. Wired to the per-task deadline. */
  signal?: AbortSignal | undefined;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cached prefix reads, when the provider reports them. */
  cacheReadTokens?: number;
}

export interface CompletionResult {
  /** Concatenated text blocks. Empty on a refusal. */
  text: string;
  /** Parsed reply when `jsonSchema` was set. Still untrusted — validate it. */
  json?: unknown;
  usage: TokenUsage;
  /** The model that actually served the turn, which may not be the one asked for. */
  model: string;
  stopReason: string;
  /**
   * True when a safety classifier declined. Distinct from an error: the call
   * succeeded, cost money, and produced no answer. Features must degrade
   * rather than surface it as a failure.
   */
  refused: boolean;
}

export interface ModelProvider {
  /** Identifies the adapter in logs and in the ai_calls ledger. */
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * A provider failure that is worth retrying, as distinct from one that is not.
 *
 * The split matters because the caller is usually a user-facing request with a
 * deadline: retrying a 429 inside it is often right, retrying a 400 never is,
 * and retrying anything without knowing which is how one bad prompt becomes
 * five billed calls.
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    opts: { status: number; retryable?: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.status === 429 || opts.status >= 500);
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * A provider that refuses to do anything.
 *
 * The composition root wires this when no API key is configured, so an
 * unconfigured deployment degrades to "the AI features are off" rather than
 * throwing at the first request. Same pattern as the notification channels:
 * absent is a coherent state, not a broken one.
 */
export const UNCONFIGURED: ModelProvider = {
  name: 'unconfigured',
  async complete(): Promise<CompletionResult> {
    throw new ProviderError('No model provider is configured.', {
      status: 503,
      retryable: false,
    });
  },
};
