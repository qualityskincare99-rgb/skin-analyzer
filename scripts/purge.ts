/**
 * Run the retention purge from the command line: `npm run purge`.
 *
 * Same policy module the cron route calls, straight against Supabase with the
 * service-role key. Use it to drain a backlog, to purge on demand, or to see
 * what the scheduled run would do.
 *
 *   npm run purge                 # real sweep
 *   npm run purge -- --dry-run    # list candidates, delete nothing
 *   npm run purge -- --limit 50
 */

import { createClient } from '@supabase/supabase-js';
import { createRepo } from '../lib/db/repo';
import { runRetentionPurge } from '../lib/privacy/purge';

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Load it from .env.local, e.g.\n  set -a && . ./.env.local && set +a && npm run purge`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;

  const repo = createRepo(
    createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    }),
  );

  if (dryRun) {
    const expired = await repo.listExpiredSessions({ limit });
    console.log(`${expired.length} session(s) past purge_after:\n`);
    for (const s of expired) {
      const action = s.scopes.includes('store_results') ? 'images only' : 'FULL DELETE';
      console.log(
        `  ${s.id}  expired ${s.purgeAfter}  images=${s.imageRefs.length}  ` +
          `consent=[${s.scopes.join(',') || 'none'}]  → ${action}`,
      );
    }
    if (expired.length === 0) console.log('  (nothing to do)');
    console.log('\nDry run: nothing was deleted.');
    return;
  }

  const report = await runRetentionPurge(repo, { limit });
  console.log(
    [
      `expired            ${report.expired}`,
      `images removed     ${report.imagesRemoved}`,
      `anonymised         ${report.sessionsAnonymised}`,
      `deleted outright   ${report.sessionsDeleted}`,
      `failed             ${report.failed.length}`,
      `more queued        ${report.more}`,
      `took               ${report.durationMs}ms`,
    ].join('\n'),
  );
  for (const f of report.failed) console.error(`  FAILED ${f.sessionId}: ${f.error}`);
  if (report.failed.length > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
