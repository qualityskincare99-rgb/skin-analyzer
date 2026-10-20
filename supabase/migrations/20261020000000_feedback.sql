-- ============================================================================
-- Customer feedback on a completed consultation.
--
-- Two shapes, one table, because they are the same event asked two ways:
--   RECOMMEND — the customer saw a routine.      rating 1-5 + optional comment
--   ESCALATE  — the customer saw a derm referral. was it clear + optional comment
-- A referral is the liability boundary, so what matters there is whether the
-- person understood it, not whether they enjoyed it. Asking someone who was
-- just told to see a doctor to award stars is the wrong question.
--
-- NO FOREIGN KEY to sessions, deliberately, same reasoning as audit_log.
-- The retention purge destroys capture frames and (absent `store_results`
-- consent) the session row with them. A review is a business record the
-- customer wrote on purpose, not biometric data, so it must outlive that
-- sweep. An explicit /delete erasure request is different and does take it:
-- repo.deleteAllForSession removes feedback rows by session_id by hand,
-- precisely because no cascade will do it.
--
-- `extra` is room to grow. Per-concern accuracy labels ("does this match what
-- you see in the mirror?") are the ground truth the weight matrix needs and
-- are currently out of scope; when they land they go in here rather than in a
-- second migration.
-- ============================================================================

create table feedback (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null,                       -- no FK, see above
  kind        text not null check (kind in ('RECOMMEND', 'ESCALATE')),
  rating      smallint check (rating between 1 and 5),
  clarity     text check (clarity in ('clear', 'unclear')),
  comment     text check (comment is null or length(comment) <= 2000),
  extra       jsonb not null default '{}',
  created_at  timestamptz not null default now(),

  -- Each kind carries its own question and only its own question. Without
  -- this a RECOMMEND row could arrive with a clarity verdict and no rating,
  -- and the analytics would quietly average over two different populations.
  constraint feedback_shape check (
       (kind = 'RECOMMEND' and rating  is not null and clarity is null)
    or (kind = 'ESCALATE'  and clarity is not null and rating  is null)
  )
);

-- One review per consultation. Enforced here and not only in the route, so a
-- double-submitted form cannot produce two rows under any race.
create unique index feedback_one_per_session_idx on feedback (session_id);
create index        feedback_created_at_idx      on feedback (created_at desc);

-- Server-only. RLS on with no policies at all is default-deny: writes go
-- through the API with the service-role key, and a browser token can neither
-- read nor write this table. Comments are free text a customer typed and may
-- contain anything, so nothing here is client-readable.
alter table feedback enable row level security;
revoke all on feedback from anon, authenticated;
