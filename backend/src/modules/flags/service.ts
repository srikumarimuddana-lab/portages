/**
 * Feature flags and kill switches.
 *
 * The lever that stops a runaway AI bill or a mis-sent alert blast without a
 * deploy. Design and rationale: analysis/11.
 *
 * THREE STATES, NOT TWO. The obvious implementation has a cache that is
 * either fresh or unavailable, and falls back to the fail-safe whenever a
 * read fails. That is wrong, and wrong in the expensive direction: a database
 * blip of two seconds would turn email off site-wide, which is a
 * self-inflicted outage caused by the safety mechanism. So:
 *
 *   FRESH  (age < TTL)            use the snapshot
 *   STALE  (TTL < age < GRACE)    use the snapshot anyway, and say so
 *   BLIND  (age > GRACE, or none) use the fail-safe defaults
 *
 * The middle state is the point. A five-second-old snapshot is knowledge, not
 * ignorance, and the fail-safe is for ignorance. An operator cannot have
 * flipped a switch during the outage either — writing a flag needs the same
 * database that is unreachable — so serving stale cannot mask a decision
 * somebody just made.
 *
 * TTL is 10s against a <30s requirement: two full refresh cycles fit inside
 * the budget, so a flip still lands in time even if one refresh is missed.
 *
 * Every method here is total. `isEnabled` never throws, never rejects, and
 * never returns undefined — a kill switch that fails closed by crashing takes
 * down the thing it was guarding, which is the opposite of its job.
 */
import { createHash } from 'node:crypto';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  FLAGS, FLAG_KEYS, defaultStateOf, isFlagKey,
  type FlagKey, type FlagTier,
} from './registry.js';
import type { Sql } from '../../db/pool.js';
import type { AuditRecorder } from '../audit/service.js';
import type { UserRole } from '../auth/service.js';
import type { Channel } from '../notify/consent.js';

/** How long a snapshot is used without re-reading. */
export const TTL_MS = 10_000;
/** How long a snapshot keeps being used after a read starts failing. */
export const GRACE_MS = 60_000;
/** How long to wait after a failed read before trying again. */
export const RETRY_MS = 2_000;

export type CacheState = 'fresh' | 'stale' | 'blind';

export interface FlagState {
  key: FlagKey;
  label: string;
  tier: FlagTier;
  enabled: boolean;
  rolloutPct: number;
  effect: string;
  /** The value used when the flag store cannot be read at all. */
  failsafe: boolean;
  /** False when no row has ever been written and the default applies. */
  configured: boolean;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

interface Row {
  key: string;
  enabled: boolean;
  rollout_pct: number;
  note: string | null;
  updated_by: string | null;
  updated_at: Date;
}

export interface FlagActor {
  userId: string;
  role: UserRole;
  ip?: string | undefined;
}

export class FlagService {
  readonly #db: Sql;
  readonly #audit: AuditRecorder | null;
  readonly #now: () => number;

  #snapshot: Map<string, Row> | null = null;
  #loadedAt = 0;
  #failedAt = 0;
  /** In-flight refresh, so a burst at TTL expiry issues one query, not fifty. */
  #inFlight: Promise<void> | null = null;

  constructor(db: Sql, opts: { audit?: AuditRecorder | null; now?: () => number } = {}) {
    this.#db = db;
    this.#audit = opts.audit ?? null;
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * Is this capability on?
   *
   * `subjectId` matters only for the rollout tier: it buckets a user
   * deterministically so they do not flip in and out of a feature on every
   * page load. Kill switches ignore it.
   */
  async isEnabled(key: FlagKey, subjectId?: string | null): Promise<boolean> {
    const snapshot = await this.#current();

    if (!snapshot) return FLAGS[key].failsafe;

    const row = snapshot.get(key);
    if (!row) return defaultStateOf(key).enabled;
    if (!row.enabled) return false;
    if (row.rollout_pct >= 100) return true;
    if (row.rollout_pct <= 0) return false;

    // A rollout with no subject cannot be bucketed. Treating that as "on"
    // would leak the feature to every anonymous visitor at once, which is the
    // opposite of a staged rollout.
    if (!subjectId) return false;
    return bucketOf(key, subjectId) < row.rollout_pct;
  }

  /**
   * Satisfies the `KillSwitch` interface NotifyService has held open since the
   * notify module shipped. Replacing its ALLOW_ALL default with this is the
   * whole wiring; no call site in that file changes.
   */
  async isChannelEnabled(channel: Channel): Promise<boolean> {
    const key = `channel.${channel}`;
    // A channel with no flag declared is not silently on: an unknown channel
    // means the registry and the notify module have drifted, and the safe
    // reading of that is that nobody decided this was allowed.
    if (!isFlagKey(key)) return false;
    return this.isEnabled(key);
  }

  /** Whether the last read succeeded. Surfaced on the admin console. */
  async cacheState(): Promise<CacheState> {
    await this.#current();
    if (!this.#snapshot) return 'blind';
    const age = this.#now() - this.#loadedAt;
    if (age < TTL_MS) return 'fresh';
    return age < GRACE_MS ? 'stale' : 'blind';
  }

  /**
   * Every flag, whether or not a row exists for it.
   *
   * The registry is the source of truth for what exists, so a flag nobody has
   * touched appears with its default rather than being invisible. A console
   * that only lists written rows is one where the switch you need at 3am is
   * the one that is not on the screen.
   */
  async list(): Promise<FlagState[]> {
    const res = await this.#db.query<Row>(
      'SELECT key, enabled, rollout_pct, note, updated_by, updated_at FROM feature_flags',
    );
    const rows = new Map(res.rows.map((r) => [r.key, r]));
    return FLAG_KEYS.map((key) => this.#stateOf(key, rows.get(key)));
  }

  /**
   * Flips a switch.
   *
   * The write and its audit entry share one transaction, so a flag cannot
   * change without the record of who changed it — the same rule every other
   * staff decision in this codebase follows.
   */
  async set(
    key: string,
    patch: { enabled?: boolean; rolloutPct?: number; note?: string | null },
    actor: FlagActor,
  ): Promise<FlagState> {
    if (!isFlagKey(key)) {
      // 404 rather than 400: an unknown key is an unknown thing, and echoing
      // it back in a validation message is how a typo looks like a real flag.
      throw notFound('No such flag.');
    }
    if (patch.rolloutPct !== undefined) {
      if (!Number.isInteger(patch.rolloutPct) || patch.rolloutPct < 0 || patch.rolloutPct > 100) {
        throw badRequest('rolloutPct must be a whole number between 0 and 100.');
      }
      if (FLAGS[key].tier === 'kill_switch' && patch.rolloutPct !== 100) {
        // A half-thrown kill switch is not a thing. "Email is 40% off" is not
        // an incident response, it is a confusing outage.
        throw badRequest('A kill switch is on or off; it has no partial rollout.');
      }
    }
    if (patch.note !== undefined && patch.note !== null && patch.note.length > 500) {
      throw badRequest('note must be 500 characters or fewer.');
    }

    const before = this.#stateOf(key, await this.#rowOf(key));

    const state = await this.#db.transaction(async (tx) => {
      // A partial patch means two different fallbacks, and they are not the
      // same value: on INSERT there is no previous row, so an unspecified
      // field takes the REGISTRY DEFAULT ($6/$7); on UPDATE it keeps whatever
      // the row already holds.
      //
      // Passing NULL for both is the obvious version and it is broken:
      // `enabled` and `rollout_pct` are NOT NULL, so the very first flip of
      // any flag — `{"enabled": false}` on a fresh install, which is the
      // common case — fails on the INSERT before ON CONFLICT can rescue it.
      // Caught by test/sql/flags.sql; the fake Sql in the unit tests does not
      // enforce NOT NULL and reported success.
      const fallback = defaultStateOf(key);
      const res = await tx.query<Row>(
        `INSERT INTO feature_flags (key, enabled, rollout_pct, note, updated_by)
              VALUES ($1, COALESCE($2, $6), COALESCE($3, $7), $4, $5)
         ON CONFLICT (key) DO UPDATE
            SET enabled     = COALESCE($2, feature_flags.enabled),
                rollout_pct = COALESCE($3, feature_flags.rollout_pct),
                note        = $4,
                updated_by  = $5
          RETURNING key, enabled, rollout_pct, note, updated_by, updated_at`,
        [
          key,
          patch.enabled ?? null,
          patch.rolloutPct ?? null,
          patch.note ?? null,
          actor.userId,
          fallback.enabled,
          fallback.rolloutPct,
        ],
      );
      const after = this.#stateOf(key, res.rows[0]);

      await this.#audit?.record(tx, {
        actorId: actor.userId,
        actorRole: actor.role,
        action: 'flag.set',
        subject: 'flag',
        subjectId: key,
        before: { enabled: before.enabled, rolloutPct: before.rolloutPct },
        after: {
          enabled: after.enabled,
          rolloutPct: after.rolloutPct,
          ...(patch.note ? { note: patch.note } : {}),
        },
        ip: actor.ip,
      });

      return after;
    });

    // Drop the local snapshot so the admin who just flipped it sees the new
    // value immediately rather than for up to TTL_MS watching a button that
    // appears not to have worked. Other processes wait out their own TTL,
    // which is what the <30s budget is for.
    this.#snapshot = null;
    this.#loadedAt = 0;
    return state;
  }

  // ── cache ─────────────────────────────────────────────────────────────

  /** The snapshot to answer from, or null when we are blind. */
  async #current(): Promise<Map<string, Row> | null> {
    const now = this.#now();
    const age = now - this.#loadedAt;

    if (this.#snapshot && age < TTL_MS) return this.#snapshot;

    // Back off after a failure rather than issuing a query per request into a
    // database that is already struggling.
    const backingOff = this.#failedAt > 0 && now - this.#failedAt < RETRY_MS;
    if (!backingOff) {
      this.#inFlight ??= this.#refresh().finally(() => { this.#inFlight = null; });
      await this.#inFlight;
    }

    if (!this.#snapshot) return null;
    return this.#now() - this.#loadedAt < GRACE_MS ? this.#snapshot : null;
  }

  async #refresh(): Promise<void> {
    try {
      const res = await this.#db.query<Row>(
        'SELECT key, enabled, rollout_pct, note, updated_by, updated_at FROM feature_flags',
      );
      this.#snapshot = new Map(res.rows.map((r) => [r.key, r]));
      this.#loadedAt = this.#now();
      this.#failedAt = 0;
    } catch {
      // Swallowed on purpose. The caller is a kill-switch check on a hot path
      // and has no useful response to a flag-store outage other than the
      // fail-safe, which #current applies. The error surfaces through
      // cacheState() on the admin console instead of taking down a send.
      this.#failedAt = this.#now();
    }
  }

  async #rowOf(key: FlagKey): Promise<Row | undefined> {
    const res = await this.#db.query<Row>(
      'SELECT key, enabled, rollout_pct, note, updated_by, updated_at FROM feature_flags WHERE key = $1',
      [key],
    );
    return res.rows[0];
  }

  #stateOf(key: FlagKey, row: Row | undefined): FlagState {
    const def = FLAGS[key];
    const fallback = defaultStateOf(key);
    return {
      key,
      label: def.label,
      tier: def.tier,
      effect: def.effect,
      failsafe: def.failsafe,
      configured: row !== undefined,
      enabled: row ? row.enabled : fallback.enabled,
      rolloutPct: row ? Number(row.rollout_pct) : fallback.rolloutPct,
      note: row?.note ?? null,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }
}

/**
 * Which rollout bucket a subject falls in, 0–99.
 *
 * Hashed rather than random so the same user gets the same answer on every
 * request — a feature that appears and disappears between page loads is worse
 * than one that is simply off. Keyed by flag as well as subject so two
 * features at 10% do not hit the identical tenth of users.
 */
export function bucketOf(key: string, subjectId: string): number {
  const digest = createHash('sha256').update(`${key}:${subjectId}`).digest();
  return digest.readUInt32BE(0) % 100;
}
