/**
 * Natural-language search.
 *
 * "two bed under $1500 near the university, parking, cat ok" becomes a
 * `FilterSpec`, which `SearchService` runs like any other search.
 *
 * THE SECURITY PROPERTY, which is the whole reason this is safe to build:
 * the model's only output is a JSON object that must satisfy
 * `filterSpecSchema`. It cannot write SQL, cannot name a column, cannot pick
 * a listing id, and cannot reach a table. Every value it produces is checked
 * against a closed set — amenities against AMENITIES, property types against
 * PROPERTY_TYPES, coordinates against a range — before a query exists. A
 * model that cannot express an injection cannot be tricked into one.
 *
 * That is not a claim about the prompt being clever. It is a claim about the
 * type, and the type is enforced by the same validator every HTTP request
 * goes through.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not generate prose about
 * listings, summarise them, or answer questions about a property. Those are
 * the features that hallucinate a bedroom that is not there, and under
 * Competition Act s.74.01 a false material representation is our problem, not
 * the model's. The AI turns words into a filter. The listings shown are
 * whatever the database returns.
 */
import * as v from '../../lib/validate.js';
import { AMENITIES, PROPERTY_TYPES, ROOM_TYPES } from '../listings/policy.js';
import { LISTING_MODES } from '../listings/state.js';
import { filterSpecSchema, validateSpec, type FilterSpec } from '../search/spec.js';
import { FENCE_RULE, fence } from './sanitize.js';
import type { CompletionResult, ModelProvider } from './provider.js';

/**
 * What the model is asked to produce.
 *
 * A strict subset of FilterSpec: no cursor (paging is ours), no bbox or
 * `near` (a model guessing coordinates for "near the university" is a model
 * inventing a location — the gazetteer resolves places, not the model), and
 * no limit. Narrowing the schema narrows the blast radius.
 */
export const SEARCH_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confident'],
  properties: {
    confident: {
      type: 'boolean',
      description: 'False when the request is not a property search at all, or is too vague to filter on.',
    },
    mode: { type: 'string', enum: [...LISTING_MODES] },
    propertyTypes: {
      type: 'array', items: { type: 'string', enum: [...PROPERTY_TYPES] }, maxItems: 8,
    },
    roomType: { type: 'string', enum: [...ROOM_TYPES] },
    minPriceCents: { type: 'integer', minimum: 0, maximum: 100_000_000_000 },
    maxPriceCents: { type: 'integer', minimum: 0, maximum: 100_000_000_000 },
    minBeds: { type: 'integer', minimum: 0, maximum: 50 },
    maxBeds: { type: 'integer', minimum: 0, maximum: 50 },
    minBaths: { type: 'number', minimum: 0, maximum: 50 },
    minSqft: { type: 'integer', minimum: 0, maximum: 100_000 },
    maxSqft: { type: 'integer', minimum: 0, maximum: 100_000 },
    amenities: {
      type: 'array', items: { type: 'string', enum: [...AMENITIES] }, maxItems: AMENITIES.length,
    },
    /** A place name, resolved by OUR gazetteer afterwards. Never coordinates. */
    place: { type: 'string', maxLength: 100 },
    /** Anything left over, passed to full-text search rather than dropped. */
    q: { type: 'string', maxLength: 200 },
    /** Shown to the user so they can see how their words were read. */
    reading: { type: 'string', maxLength: 300 },
  },
} as const;

/** The parsed model output, before it becomes a FilterSpec. */
const intentSchema = v.object({
  confident: v.boolean(),
  mode: v.optional(v.enumOf(LISTING_MODES)),
  propertyTypes: v.optional(v.array(v.enumOf(PROPERTY_TYPES), { max: 8 })),
  roomType: v.optional(v.enumOf(ROOM_TYPES)),
  minPriceCents: v.optional(v.integer({ min: 0, max: 100_000_000_000 })),
  maxPriceCents: v.optional(v.integer({ min: 0, max: 100_000_000_000 })),
  minBeds: v.optional(v.integer({ min: 0, max: 50 })),
  maxBeds: v.optional(v.integer({ min: 0, max: 50 })),
  minBaths: v.optional(v.number({ min: 0, max: 50 })),
  minSqft: v.optional(v.integer({ min: 0, max: 100_000 })),
  maxSqft: v.optional(v.integer({ min: 0, max: 100_000 })),
  amenities: v.optional(v.array(v.enumOf(AMENITIES), { max: AMENITIES.length })),
  place: v.optional(v.string({ max: 100 })),
  q: v.optional(v.string({ max: 200 })),
  reading: v.optional(v.string({ max: 300 })),
});

export const SYSTEM_PROMPT = [
  'You convert a person\'s description of the home they want into search filters for Portage,',
  'an owner-direct property marketplace in Regina, Saskatchewan.',
  '',
  'Return ONLY the JSON object described by the schema. You are not writing to the person.',
  '',
  'Rules:',
  '- Set confident=false if the message is not about finding a property, or is too vague to',
  '  turn into any filter at all. An empty filter set matching everything is worse than saying so.',
  '- Prices are in CENTS. "$1500" is 150000. Rent is monthly; sale prices are totals.',
  '- Use ONLY the enum values given. If someone wants something not in the amenity list,',
  '  put it in q rather than inventing a value.',
  '- Put place names in `place` as written. Do NOT produce coordinates — you do not know',
  '  where anything in Regina is, and a guessed coordinate silently searches the wrong area.',
  '- "cheap", "affordable" and similar are not prices. Leave the price fields alone rather',
  '  than inventing a number the person did not say.',
  '- `reading` is one short sentence telling the person how you read their words, so a',
  '  misreading is visible to them. Plain language, no JSON, no filter names.',
  '',
  FENCE_RULE,
].join('\n');

export interface ChatSearchResult {
  /** Null when the model was not confident, refused, or produced junk. */
  spec: (FilterSpec & { place?: string }) | null;
  /** One line for the user: how their words were read. */
  reading: string | null;
  /** Why there is no spec, when there is none. Never shown raw to a user. */
  reason?: 'not_confident' | 'refused' | 'unparseable' | 'invalid' | 'contradictory';
  usage: CompletionResult['usage'];
  model: string;
}

export interface ChatSearchDeps {
  provider: ModelProvider;
  model: string;
  maxTokens?: number;
}

export class ChatSearchService {
  readonly #deps: ChatSearchDeps;

  constructor(deps: ChatSearchDeps) {
    this.#deps = deps;
  }

  /**
   * Turns a sentence into a filter.
   *
   * Never throws for a bad model reply. Every failure path returns a null spec
   * with a reason, because the caller's fallback — run the words as a plain
   * text search — is a perfectly good search, and a 500 on the search page is
   * not.
   */
  async interpret(message: string, opts: { signal?: AbortSignal } = {}): Promise<ChatSearchResult> {
    const result = await this.#deps.provider.complete({
      task: 'chat_search',
      system: SYSTEM_PROMPT,
      // The user's own words are still fenced. They are the least likely
      // source of an attack — a searcher attacking themselves gains nothing —
      // but the fence costs nothing and this is the path a shared or
      // bookmarked "search link" would travel.
      messages: [{ role: 'user', content: fence('request', message) }],
      jsonSchema: SEARCH_INTENT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: this.#deps.maxTokens ?? 512,
      model: this.#deps.model,
      // Turning a sentence into filters is extraction, not reasoning. Low
      // effort is both cheaper and faster, and the schema does the work that
      // thinking would otherwise do.
      effort: 'low',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const base = { usage: result.usage, model: result.model };

    if (result.refused) return { spec: null, reading: null, reason: 'refused', ...base };
    if (result.json === undefined) return { spec: null, reading: null, reason: 'unparseable', ...base };

    // The model's output is untrusted input, validated exactly like a request
    // body. `v.object` rejects unknown keys, so a field the model invented is
    // a rejection rather than something quietly carried into a query.
    const parsed = intentSchema.parse(result.json, 'intent');
    if (!parsed.ok) return { spec: null, reading: null, reason: 'invalid', ...base };

    const intent = parsed.value;
    const reading = intent.reading ?? null;
    if (!intent.confident) return { spec: null, reading, reason: 'not_confident', ...base };

    const { confident: _confident, reading: _reading, place, ...filters } = intent;

    // Second pass through the real schema. The intent schema is a subset, so
    // this cannot fail on a well-formed intent — which is the point of running
    // it anyway: if the two ever drift apart, this is where it is caught,
    // rather than in the query builder.
    const spec = filterSpecSchema.parse(filters, 'spec');
    if (!spec.ok) return { spec: null, reading, reason: 'invalid', ...base };

    // Cross-field checks the per-field schema cannot see. A model that emits
    // min > max produces a query that is valid, runs fine, and returns
    // nothing — the worst possible failure, because it looks like an answer.
    const problems = validateSpec(spec.value as FilterSpec);
    if (problems.length > 0) {
      return { spec: null, reading, reason: 'contradictory', ...base };
    }

    return {
      spec: { ...(spec.value as FilterSpec), ...(place ? { place } : {}) },
      reading,
      ...base,
    };
  }
}
