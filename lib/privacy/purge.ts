/**
 * Retention purge (spec §12) — the thing that makes the consent screen's
 * "deleted within 24 hours" a fact rather than a sentence.
 *
 * The schema has carried `sessions.purge_after` and an index on it since the
 * first migration, and nothing has ever read them. This is the reader.
 *
 * Policy, and the reasoning for it:
 *
 *   Capture frames are biometric data and are what the promise is about, so
 *   they go at `purge_after`, unconditionally, for every session.
 *
 *   What happens to the rest depends on consent. The normalised assessment
 *   (concern keys, severities, confidences) is not biometric and carries no
 *   likeness — it is also precisely the data needed to tune the weight matrix
 *   against the real customer base. A session that granted `store_results`
 *   keeps those rows after its images are gone. A session that did not is
 *   cascade-deleted whole.
 *
 *   Today the UI always requests `store_results`, so in practice every
 *   session takes the first path. That is a UI decision, not a policy one,
 *   and the moment the consent screen offers a real choice this honours it
 *   with no further work.
 *
 * The audit row survives either way: `audit_log` deliberately has no foreign
 * key to `sessions`, so proof that a purge happened outlives the data it
 * destroyed. An auditable deletion is the only kind worth promising.
 */

import type { SkinRepo } from '../db/repo';

export interface PurgeReport {
  /** Sessions found past `purge_after` in this run. */
  expired: number;
  /** Storage objects deleted. */
  imagesRemoved: number;
  /** Images dropped, anonymous assessment rows kept (`store_results` granted). */
  sessionsAnonymised: number;
  /** Cascade-deleted whole (no `store_results` consent). */
  sessionsDeleted: number;
  /** Sessions that threw. The run continues; these are retried next tick. */
  failed: { sessionId: string; error: string }[];
  /** True when the cap was hit, i.e. more work is waiting for the next run. */
  more: boolean;
  startedAt: string;
  durationMs: number;
}

export interface PurgeOptions {
  /** Treat this as "now". Tests pass a fixed clock; production passes nothing. */
  now?: Date;
  /** Cap on sessions handled per run. Keeps one invocation inside the function
   *  timeout; a backlog drains over successive runs rather than failing. */
  limit?: number;
}

export async function runRetentionPurge(
  repo: SkinRepo,
  opts: PurgeOptions = {},
): Promise<PurgeReport> {
  const started = Date.now();
  const limit = opts.limit ?? 200;
  const expired = await repo.listExpiredSessions({ now: opts.now, limit });

  const report: PurgeReport = {
    expired: expired.length,
    imagesRemoved: 0,
    sessionsAnonymised: 0,
    sessionsDeleted: 0,
    failed: [],
    more: expired.length === limit,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
  };

  for (const session of expired) {
    try {
      if (session.scopes.includes('store_results')) {
        report.imagesRemoved += await repo.purgeImages(session.id, session.imageRefs);
        report.sessionsAnonymised += 1;
        await repo.logAudit('PURGE', session.id, {
          action: 'images_only',
          images_removed: session.imageRefs.length,
          purge_after: session.purgeAfter,
        });
      } else {
        const { imagesRemoved } = await repo.deleteAllForSession(session.id);
        report.imagesRemoved += imagesRemoved;
        report.sessionsDeleted += 1;
        await repo.logAudit('PURGE', session.id, {
          action: 'full_delete',
          images_removed: imagesRemoved,
          purge_after: session.purgeAfter,
          reason: 'no store_results consent',
        });
      }
    } catch (err) {
      // One poisoned session must not strand every session behind it. Record
      // it, carry on, and let the next run try again: `purge_after` is still
      // in the past, so it stays in the candidate set until it succeeds.
      report.failed.push({
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}
