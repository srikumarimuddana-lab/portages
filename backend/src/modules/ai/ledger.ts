/**
 * The AI call ledger, and the provider decorator that fills it.
 *
 * `MeteredProvider` wraps any `ModelProvider` and records what each call
 * cost. A decorator rather than a call in each feature, for one reason: three
 * features times four outcomes is twelve places to remember, and the one
 * forgotten is always the error path — which is exactly the row you want when
 * the bill is wrong.
 *
 * Wrapping means a feature CANNOT make an unrecorded call. It does not know
 * it is being metered and has no way to opt out.
 *
 * NOTHING RECORDED HERE IS CONTENT. Not the prompt, not the reply, not the
 * message body. See migrations/016_ai.sql for why that is a hard line and not
 * a default that could be relaxed later.
 */
import {
  ProviderError,
  type AiTask, type CompletionRequest, type CompletionResult, type ModelProvider,
} from './provider.js';
import type { Sql } from '../../db/pool.js';

export type CallOutcome = 'ok' | 'refused' | 'unparseable' | 'error' | 'timeout';

export interface CallRecord {
  task: AiTask;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  outcome: CallOutcome;
  latencyMs: number;
  actorId?: string | undefined;
  subjectType?: 'listing' | 'message' | 'thread' | undefined;
  subjectId?: string | undefined;
}

/** Narrow interface, so tests and the decorator do not need a database. */
export interface CallRecorder {
  record(entry: CallRecord): Promise<void>;
}

export class AiLedger implements CallRecorder {
  readonly #db: Sql;

  constructor(db: Sql) {
    this.#db = db;
  }

  async record(entry: CallRecord): Promise<void> {
    await this.#db.query(
      `INSERT INTO ai_calls
         (task, provider, model, input_tokens, output_tokens, cache_read_tokens,
          outcome, latency_ms, actor_id, subject_type, subject_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        entry.task, entry.provider, entry.model,
        entry.inputTokens, entry.outputTokens, entry.cacheReadTokens ?? null,
        entry.outcome, entry.latencyMs,
        entry.actorId ?? null, entry.subjectType ?? null, entry.subjectId ?? null,
      ],
    );
  }

  /**
   * Spend and failure rates by task, for the ops view.
   *
   * Failure counts sit beside the token totals rather than in a separate
   * query, because the pair is what makes either readable: rising spend with
   * a rising refusal rate is a prompt regression burning money for nothing,
   * while rising spend with a flat one is just usage.
   */
  async summary(sinceHours = 24): Promise<Array<{
    task: string; calls: number; inputTokens: number; outputTokens: number;
    refused: number; errored: number; p95LatencyMs: number | null;
  }>> {
    const res = await this.#db.query<{
      task: string; calls: string; input_tokens: string; output_tokens: string;
      refused: string; errored: string; p95: number | null;
    }>(
      `SELECT task,
              count(*)::text                                       AS calls,
              coalesce(sum(input_tokens), 0)::text                 AS input_tokens,
              coalesce(sum(output_tokens), 0)::text                AS output_tokens,
              count(*) FILTER (WHERE outcome = 'refused')::text    AS refused,
              count(*) FILTER (WHERE outcome IN ('error','timeout'))::text AS errored,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
         FROM ai_calls
        WHERE at > now() - make_interval(hours => $1)
        GROUP BY task
        ORDER BY task`,
      [sinceHours],
    );
    return res.rows.map((r) => ({
      task: r.task,
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      refused: Number(r.refused),
      errored: Number(r.errored),
      p95LatencyMs: r.p95 === null ? null : Number(r.p95),
    }));
  }
}

/** Per-call attribution the provider itself cannot know. */
export interface CallContext {
  actorId?: string | undefined;
  subjectType?: 'listing' | 'message' | 'thread' | undefined;
  subjectId?: string | undefined;
}

/**
 * Wraps a provider so every call lands in the ledger.
 *
 * Attribution is set with `for()`, which returns a provider bound to one
 * actor and subject. That is how a feature says "this call was made for user
 * X about listing Y" without the ledger call appearing in the feature's own
 * code — and without a mutable field on a shared instance, which on a
 * serverless instance handling concurrent requests would attribute calls to
 * whoever happened to be last.
 */
export class MeteredProvider implements ModelProvider {
  readonly name: string;

  readonly #inner: ModelProvider;
  readonly #recorder: CallRecorder | null;
  readonly #ctx: CallContext;
  readonly #now: () => number;

  constructor(
    inner: ModelProvider,
    recorder: CallRecorder | null,
    opts: { context?: CallContext; now?: () => number } = {},
  ) {
    this.#inner = inner;
    this.#recorder = recorder;
    this.#ctx = opts.context ?? {};
    this.#now = opts.now ?? (() => Date.now());
    this.name = inner.name;
  }

  /** A provider bound to one actor and subject. Never mutates this one. */
  for(context: CallContext): MeteredProvider {
    return new MeteredProvider(this.#inner, this.#recorder, {
      context, now: this.#now,
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const startedAt = this.#now();
    try {
      const result = await this.#inner.complete(req);
      await this.#write({
        task: req.task,
        provider: this.#inner.name,
        // The model that SERVED, not the one requested — the Gateway fails
        // over, and a bill nobody can attribute is a bill nobody can reduce.
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        // Spread conditionally rather than assigned as undefined: an
        // explicit key with no value is a key, and the ledger record is
        // asserted field-by-field precisely so that nothing creeps into it.
        ...(result.usage.cacheReadTokens !== undefined
          ? { cacheReadTokens: result.usage.cacheReadTokens }
          : {}),
        // A refusal is billed and produces nothing, so it is its own outcome
        // rather than an error or a success.
        outcome: result.refused
          ? 'refused'
          : (req.jsonSchema && result.json === undefined ? 'unparseable' : 'ok'),
        latencyMs: this.#now() - startedAt,
        ...this.#ctx,
      });
      return result;
    } catch (err) {
      await this.#write({
        task: req.task,
        provider: this.#inner.name,
        model: req.model,
        inputTokens: 0,
        outputTokens: 0,
        outcome: err instanceof ProviderError && err.status === 504 ? 'timeout' : 'error',
        latencyMs: this.#now() - startedAt,
        ...this.#ctx,
      });
      throw err;
    }
  }

  /**
   * Writes the record, swallowing its own failures.
   *
   * A ledger write that can fail a model call would mean a database blip
   * takes down search — trading a real outage for a missing row in an
   * observability table. The row is worth having; it is not worth that.
   */
  async #write(entry: CallRecord): Promise<void> {
    if (!this.#recorder) return;
    try {
      await this.#recorder.record(entry);
    } catch {
      // Intentionally silent. The alternative is failing the user's request
      // to record that we served it.
    }
  }
}
