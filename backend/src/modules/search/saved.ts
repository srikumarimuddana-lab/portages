/**
 * Saved searches, and the alerts they can send.
 *
 * THE CONSENT INVARIANT IS THE WHOLE OF THIS MODULE. An alert is a commercial
 * electronic message under CASL, so it may only be sent with express consent
 * that the sender can produce evidence of, and withdrawal must be honoured
 * without a grace period. Penalties run to $10M per violation, which is more
 * than this business is worth, so the rule is enforced in three places that do
 * not depend on each other:
 *
 *   1. THE DATABASE. `alert_requires_consent` refuses any row with
 *      alert_enabled = true and no consent_id. A bug here cannot write the
 *      state that would let an unlawful send happen.
 *   2. HERE. Enabling an alert grants a consent row first and stores its id;
 *      disabling revokes it. The evidence recorded is what was actually
 *      clicked, not "the user consented".
 *   3. THE SEND PATH. `NotifyService` re-checks consent immediately before
 *      handing anything to a provider.
 *
 * The third is not redundant. The CHECK constraint proves a consent row was
 * referenced, not that it is still LIVE — a consent revoked through the
 * unsubscribe link leaves `alert_enabled` true and `consent_id` pointing at a
 * revoked row, and the only thing that stops the send is the runtime check.
 * Any one of the three failing leaves the other two standing.
 */
import { badRequest, notFound } from '../../lib/errors.js';
import type { Sql } from '../../db/pool.js';
import type { ConsentService } from '../notify/consent.js';
import type { SearchService } from './service.js';
import type { FilterSpec, SortOrder } from './spec.js';

export const ALERT_FREQUENCIES = ['instant', 'daily', 'weekly'] as const;
export type AlertFrequency = (typeof ALERT_FREQUENCIES)[number];

/**
 * How long between alert runs, per frequency.
 *
 * Mirrored by the CASE in `due()`. Exported so a test can assert the two say
 * the same thing rather than drifting — the SQL is where it is enforced, and
 * this is what the rest of the code and the UI reason about.
 */
export const INTERVAL_HOURS: Record<AlertFrequency, number> = {
  instant: 1,
  daily: 24,
  weekly: 24 * 7,
};

/** One person may keep this many. Enough for a real search, not a crawler. */
export const MAX_SAVED_SEARCHES = 25;

export interface SavedSearch {
  id: string;
  name: string;
  spec: FilterSpec & { sort?: SortOrder };
  frequency: AlertFrequency;
  alertEnabled: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
}

export interface SavedSearchDeps {
  db: Sql;
  /** Validates a spec, so a saved search is a valid search forever. */
  search: SearchService;
  consent: ConsentService;
  now?: () => Date;
}

export class SavedSearchService {
  readonly #db: Sql;
  readonly #search: SearchService;
  readonly #consent: ConsentService;
  readonly #now: () => Date;

  constructor(deps: SavedSearchDeps) {
    this.#db = deps.db;
    this.#search = deps.search;
    this.#consent = deps.consent;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Saves a search.
   *
   * The spec is parsed through `SearchService` before it is stored, which is
   * the difference between a saved search and a stored blob of JSON: a spec
   * that would be rejected today must not be accepted now and then fail every
   * night for a year inside a job nobody is watching.
   */
  async save(input: {
    userId: string;
    name: string;
    spec: unknown;
    frequency?: AlertFrequency;
    alertEnabled?: boolean;
    /** What the person actually did, recorded as consent evidence. */
    evidence?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 120) {
      throw badRequest('Give the search a name of up to 120 characters.');
    }

    // Throws on anything the search module would refuse. `cursor` is dropped:
    // a saved search is a standing query, and page two of a result set from
    // last Tuesday is not a thing to re-run.
    const parsed = this.#search.parse(input.spec);
    const { cursor: _cursor, ...spec } = parsed;

    const count = await this.#db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM saved_searches WHERE user_id = $1',
      [input.userId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= MAX_SAVED_SEARCHES) {
      throw badRequest(`You can keep ${MAX_SAVED_SEARCHES} saved searches. Remove one to add another.`);
    }

    const frequency = input.frequency ?? 'daily';
    // Consent BEFORE the insert, so the row can never exist in the state the
    // CHECK constraint forbids — and so a failure to record consent is a
    // failure to save, rather than a saved search that quietly cannot alert.
    const consentId = input.alertEnabled
      ? await this.#grant(input.userId, name, input.evidence)
      : null;

    const { rows } = await this.#db.query<{ id: string }>(
      `INSERT INTO saved_searches (user_id, name, query, frequency, alert_enabled, consent_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [input.userId, name, JSON.stringify(spec), frequency, input.alertEnabled === true, consentId],
    );
    return { id: rows[0]!.id };
  }

  async list(userId: string): Promise<SavedSearch[]> {
    const { rows } = await this.#db.query<{
      id: string; name: string; query: FilterSpec; frequency: AlertFrequency;
      alert_enabled: boolean; last_run_at: Date | null; created_at: Date;
    }>(
      `SELECT id, name, query, frequency, alert_enabled, last_run_at, created_at
         FROM saved_searches
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      spec: r.query,
      frequency: r.frequency,
      alertEnabled: r.alert_enabled,
      lastRunAt: r.last_run_at,
      createdAt: r.created_at,
    }));
  }

  /**
   * Turns alerts on or off for one saved search.
   *
   * Turning them ON grants consent and stores the id. Turning them OFF revokes
   * it — not just clears the flag. A revoked consent is what an unsubscribe
   * has to produce; leaving the row live and only flipping a boolean would
   * mean the evidence trail says the person still wants these.
   */
  async setAlert(
    id: string,
    userId: string,
    input: { enabled: boolean; frequency?: AlertFrequency; evidence?: Record<string, unknown> },
  ): Promise<void> {
    const { rows } = await this.#db.query<{ name: string; alert_enabled: boolean }>(
      'SELECT name, alert_enabled FROM saved_searches WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    const row = rows[0];
    if (!row) throw notFound('Saved search not found.');

    if (!input.enabled) {
      await this.#db.query(
        `UPDATE saved_searches
            SET alert_enabled = false, consent_id = NULL,
                frequency = COALESCE($3, frequency)
          WHERE id = $1 AND user_id = $2`,
        [id, userId, input.frequency ?? null],
      );
      // After the row, not before: if this fails, the alert is already off and
      // the worst case is a live consent row nothing sends against. The other
      // order risks a revoked consent on a search still marked enabled.
      await this.#consent.revoke(userId, 'saved_search_alert', 'email');
      return;
    }

    const consentId = await this.#grant(userId, row.name, input.evidence);
    await this.#db.query(
      `UPDATE saved_searches
          SET alert_enabled = true, consent_id = $3,
              frequency = COALESCE($4, frequency)
        WHERE id = $1 AND user_id = $2`,
      [id, userId, consentId, input.frequency ?? null],
    );
  }

  async rename(id: string, userId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 120) {
      throw badRequest('Give the search a name of up to 120 characters.');
    }
    const res = await this.#db.query(
      'UPDATE saved_searches SET name = $3 WHERE id = $1 AND user_id = $2',
      [id, userId, trimmed],
    );
    if (res.rowCount === 0) throw notFound('Saved search not found.');
  }

  /** Deleting a saved search revokes the consent it was carrying. */
  async remove(id: string, userId: string): Promise<void> {
    const { rows } = await this.#db.query<{ alert_enabled: boolean }>(
      'DELETE FROM saved_searches WHERE id = $1 AND user_id = $2 RETURNING alert_enabled',
      [id, userId],
    );
    const row = rows[0];
    if (!row) throw notFound('Saved search not found.');
    // Deleting the search that consent was granted for withdraws it. Leaving
    // it live would mean an evidence trail claiming consent for a search that
    // no longer exists.
    if (row.alert_enabled) {
      await this.#consent.revoke(userId, 'saved_search_alert', 'email');
    }
  }

  /**
   * Alerts that are due, oldest first.
   *
   * `last_run_at IS NULL` is due immediately: a search saved with alerts on
   * should produce its first alert on the next run rather than waiting a full
   * period for a clock it was never part of.
   */
  async due(limit = 200): Promise<Array<SavedSearch & { userId: string; email: string }>> {
    const { rows } = await this.#db.query<{
      id: string; user_id: string; email: string; name: string; query: FilterSpec;
      frequency: AlertFrequency; last_run_at: Date | null; created_at: Date;
    }>(
      // The interval is per-row, so the comparison is a CASE rather than a
      // parameter. Doing it in SQL matters: filtering in memory would fetch
      // every enabled alert on every run and discard most of them, and the
      // LIMIT would then be a limit on rows READ rather than on work done.
      `SELECT s.id, s.user_id, u.email, s.name, s.query, s.frequency,
              s.last_run_at, s.created_at
         FROM saved_searches s
         JOIN users u ON u.id = s.user_id
        WHERE s.alert_enabled = true
          AND s.consent_id IS NOT NULL
          AND u.status = 'active'
          AND (s.last_run_at IS NULL
               OR s.last_run_at < now() - CASE s.frequency
                    WHEN 'instant' THEN interval '1 hour'
                    WHEN 'daily'   THEN interval '24 hours'
                    ELSE                interval '7 days'
                  END)
        ORDER BY s.last_run_at NULLS FIRST
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return rows
      .map((r) => ({
        id: r.id,
        userId: r.user_id,
        email: r.email,
        name: r.name,
        spec: r.query,
        frequency: r.frequency,
        alertEnabled: true,
        lastRunAt: r.last_run_at,
        createdAt: r.created_at,
      }));
  }

  /**
   * Listings this search has matched since it last ran.
   *
   * Anchored to `last_run_at` rather than to a fixed window, so a run that was
   * late or that failed yesterday does not silently skip the listings it
   * should have mentioned.
   *
   * WHY THIS COUNTS IN MEMORY rather than with a `publishedAfter` filter:
   * `FilterSpec` has no such field, and adding one would put a new column
   * comparison into the query builder and its schema for the sake of one
   * caller. Sorting by newest and stopping at the page limit answers the same
   * question — "are there new ones, and roughly how many" — which is all an
   * alert needs. `atLeast` says the count is a floor, so the email can say
   * "20+" rather than claiming a precision it does not have.
   *
   * A search that has never run reports nothing: its first alert would
   * otherwise be every listing that ever matched it.
   */
  async newMatches(
    s: { spec: FilterSpec; lastRunAt: Date | null },
    limit = 20,
  ): Promise<{ count: number; atLeast: boolean }> {
    if (s.lastRunAt === null) return { count: 0, atLeast: false };

    const page = await this.#search.search({ ...s.spec, sort: 'newest', limit });
    const since = s.lastRunAt.getTime();
    const fresh = page.results.filter(
      (r) => r.publishedAt !== null && r.publishedAt.getTime() > since,
    );
    // Every row on a full page being new means there are probably more behind
    // it. Saying so beats reporting exactly the page size as if it were the
    // total.
    return { count: fresh.length, atLeast: fresh.length === limit };
  }

  /**
   * One alert run.
   *
   * Every due search is marked as having run WHETHER OR NOT it produced an
   * email, and whether or not the send succeeded. That is deliberate: the
   * alternative is a search that fails to send and is therefore still due on
   * the next tick, retrying forever and mailing the same person repeatedly the
   * moment the failure clears. A missed alert is a listing seen a day late; a
   * retry loop on a commercial message is a CASL problem.
   *
   * Nothing is sent for a search with no new matches. "0 new listings match
   * your search" is a commercial message about nothing, sent to somebody who
   * consented to hear about listings.
   */
  async runAlerts(deps: {
    notify: {
      send(input: {
        to: string; channel: 'email'; template: 'saved_search_alert';
        vars: Record<string, string>; category: 'saved_search_alert';
        userId: string; idempotencyKey: string;
      }): Promise<unknown>;
    };
    origin: string;
    limit?: number;
  }): Promise<{ considered: number; sent: number }> {
    const due = await this.due(deps.limit ?? 200);
    let sent = 0;

    for (const s of due) {
      // Marked first. If the send throws, this search is not still due — see
      // the note above about retry loops on commercial messages.
      await this.markRun(s.id);

      let matches: { count: number; atLeast: boolean };
      try {
        matches = await this.newMatches(s);
      } catch {
        // A saved spec that no longer parses should not stop the whole run.
        continue;
      }
      if (matches.count === 0) continue;

      await deps.notify.send({
        to: s.email,
        channel: 'email',
        template: 'saved_search_alert',
        vars: {
          count: matches.atLeast ? `${matches.count}+` : String(matches.count),
          searchName: s.name,
          link: `${deps.origin}/search?saved=${encodeURIComponent(s.id)}`,
        },
        category: 'saved_search_alert',
        userId: s.userId,
        // Keyed to the run, not to the search: two runs an hour apart are two
        // alerts, and the same run retried is one.
        idempotencyKey: `alert:${s.id}:${new Date().toISOString().slice(0, 13)}`,
      });
      sent += 1;
    }

    return { considered: due.length, sent };
  }

  /** Records that a search ran, whether or not it had anything to say. */
  async markRun(id: string): Promise<void> {
    await this.#db.query('UPDATE saved_searches SET last_run_at = now() WHERE id = $1', [id]);
  }

  /**
   * Grants consent and returns its id.
   *
   * The evidence is what the person actually did — the page, the control, the
   * time — because "the user consented" is not evidence, and CASL puts the
   * burden of proving consent on the sender.
   */
  async #grant(
    userId: string,
    searchName: string,
    evidence: Record<string, unknown> | undefined,
  ): Promise<string> {
    return this.#consent.grant({
      userId,
      kind: 'saved_search_alert',
      channel: 'email',
      evidence: {
        searchName,
        grantedAt: this.#now().toISOString(),
        ...evidence,
      },
    });
  }
}
