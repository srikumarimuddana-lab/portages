/**
 * Vercel AI Gateway adapter — the primary provider.
 *
 * Speaks the Gateway's OpenAI-compatible HTTP surface directly, with `fetch`
 * and nothing else. That is a deliberate choice, not a workaround waiting to
 * be replaced:
 *
 *   * It works today. The `ai` package cannot be installed in the environment
 *     this was written in (npm returns 403 by policy), and a module that only
 *     compiles is not a module that works.
 *   * It keeps the runtime dependency count at one (`pg`), which is the
 *     property that has made every other integration here — SigV4, SES, JWKS,
 *     S3 presigning — auditable in a single file.
 *   * The Gateway is the routing layer either way. The AI SDK is a client for
 *     it; going direct loses the SDK's ergonomics, not the Gateway's features
 *     (failover, spend caps, provider fan-out, one key for every model).
 *
 * `adapters/vercel-ai.ts` is the AI SDK implementation of the same interface,
 * for when npm is available and the SDK's streaming and tool-calling helpers
 * start earning their weight. Both satisfy `ModelProvider`; swapping them is
 * one line in the composition root.
 *
 * AUTH. The Gateway takes either an explicit `AI_GATEWAY_API_KEY` or the OIDC
 * token Vercel provisions for a linked project. The OIDC token is short-lived
 * and refreshed by the platform, so it is read per request rather than
 * captured at construction — a token cached at boot is a token that expires
 * mid-afternoon on a warm serverless instance.
 */
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
} from '../provider.js';

export interface GatewayConfig {
  /** Explicit key. When absent the adapter falls back to the OIDC token. */
  apiKey?: string | undefined;
  /** Reads the current OIDC token. Called per request, never cached. */
  oidcToken?: (() => string | undefined) | undefined;
  /** Override for tests and for self-hosted gateways. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Hard ceiling per call. A hung provider must not hold a request open. */
  timeoutMs?: number | undefined;
}

const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

export class GatewayProvider implements ModelProvider {
  readonly name = 'vercel-ai-gateway';

  readonly #cfg: GatewayConfig;
  readonly #fetch: typeof fetch;

  constructor(cfg: GatewayConfig = {}) {
    this.#cfg = cfg;
    this.#fetch = cfg.fetchImpl ?? globalThis.fetch;
  }

  /** Whether a call could even be attempted. Mirrors the notify channels. */
  isConfigured(): boolean {
    return Boolean(this.#cfg.apiKey || this.#cfg.oidcToken?.());
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const token = this.#cfg.apiKey || this.#cfg.oidcToken?.();
    if (!token) {
      throw new ProviderError('AI Gateway credentials are not configured.', {
        status: 503, retryable: false,
      });
    }

    // Two abort sources: the caller's deadline and ours. Whichever fires
    // first wins, so a caller that forgot a signal still cannot hang forever.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const onCallerAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onCallerAbort);

    try {
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      };
      if (req.jsonSchema) {
        // The Gateway normalizes this to each provider's own structured-output
        // mechanism. `strict` is what turns "usually valid JSON" into a
        // guarantee — without it the parse below becomes the error path
        // rather than the happy one.
        body['response_format'] = {
          type: 'json_schema',
          json_schema: { name: 'result', strict: true, schema: req.jsonSchema },
        };
      }

      const res = await this.#fetch(`${this.#cfg.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          // Shows up in the Gateway's per-app spend breakdown, which is what
          // makes "which feature cost that" answerable without instrumenting
          // anything else.
          'http-referer': 'https://portage.ca',
          'x-title': `portage/${req.task}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) throw await errorFrom(res);

      const json = (await res.json()) as GatewayResponse;
      return interpret(json, req);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (isAbort(err)) {
        throw new ProviderError('The model did not respond in time.', {
          status: 504, retryable: true,
        });
      }
      throw new ProviderError(
        err instanceof Error ? err.message : 'Gateway request failed.',
        { status: 502, retryable: true },
      );
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

interface GatewayResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Turns the wire response into a `CompletionResult`.
 *
 * A refusal is NOT an error here. The call succeeded, was billed, and
 * produced no answer — features have to degrade rather than 500, which they
 * can only do if the distinction survives this function.
 */
function interpret(json: GatewayResponse, req: CompletionRequest): CompletionResult {
  const choice = json.choices?.[0];
  const refusal = choice?.message?.refusal ?? null;
  const text = choice?.message?.content ?? '';

  const usage = {
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    ...(json.usage?.prompt_tokens_details?.cached_tokens !== undefined
      ? { cacheReadTokens: json.usage.prompt_tokens_details.cached_tokens }
      : {}),
  };

  if (refusal) {
    return {
      text: '', usage, model: json.model ?? req.model,
      stopReason: 'refusal', refused: true,
    };
  }

  const result: CompletionResult = {
    text,
    usage,
    model: json.model ?? req.model,
    stopReason: choice?.finish_reason ?? 'stop',
    refused: false,
  };

  if (req.jsonSchema) {
    try {
      result.json = JSON.parse(text) as unknown;
    } catch {
      // Left undefined rather than thrown. The caller validates the parsed
      // value against a schema anyway, and "the model returned prose" and
      // "the model returned JSON with a bad field" deserve the same handling:
      // fall back, do not fail the user's request.
      result.json = undefined;
    }
  }
  return result;
}

async function errorFrom(res: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    detail = '';
  }

  // Retry-After is seconds or an HTTP date. Only the numeric form is worth
  // honouring; a date form on a rate limit is vanishingly rare and parsing it
  // wrong is worse than ignoring it.
  const retryAfter = Number(res.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : undefined;

  return new ProviderError(
    detail || `AI Gateway returned ${res.status}.`,
    {
      status: res.status,
      // A 401/403 is a credential problem and retrying it just burns the
      // request budget; the OIDC token needs refreshing instead.
      retryable: res.status === 429 || res.status >= 500,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
