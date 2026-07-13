-- ============================================================================
-- Quality SkinCare — AI Skin Analyzer: initial schema
-- Source of truth: docs/skin-analyzer-spec.md  §9 (schema) · §12 (privacy)
--
-- NOT YET APPLIED — no Supabase project is connected. Apply with the Supabase
-- CLI (`supabase db push`) once one exists. Requires the Supabase runtime
-- (auth.jwt(), anon/authenticated/service_role roles); plain Postgres won't do.
--
-- Deviations from the spec's sketch SQL — hardening only, no semantic changes:
--   • session_id on consent/analyses/answers/recommendations: NOT NULL + FK
--     with ON DELETE CASCADE (the /delete erasure path relies on the cascade)
--   • purge_after defaults to now() + 24h (§12: 24h default image retention)
--   • CHECK constraints where the spec enumerates values (route, consent scope)
--   • indexes on the session_id lookups and on purge_after (purge-job scan)
--   • audit_log deliberately has NO session FK: audit rows (DELETE_REQ, PURGE)
--     must survive the session cascade delete.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Tables
-- ────────────────────────────────────────────────────────────────────────────

create table sessions (
  id                  uuid primary key default gen_random_uuid(),
  shopify_customer_id text,                          -- null for guests
  state               text not null default 'INIT',  -- consultation state machine, §2
  skin_type           text,
  skin_type_conf      real,
  route               text check (route in ('RECOMMEND', 'CLARIFY', 'CONSULT', 'ESCALATE')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  purge_after         timestamptz not null default now() + interval '24 hours'  -- images purged past this
);

-- Consent is a hard prerequisite; no image touches storage without a row here.
create table consent (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id) on delete cascade,
  scope       text[] not null
                check (cardinality(scope) > 0
                       and scope <@ array['image_analysis', 'store_results', 'marketing']::text[]),
  ip_hash     text,                                  -- hashed, never raw IP
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table analyses (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id) on delete cascade,
  provider      text not null,
  image_quality real,
  concerns      jsonb not null,                      -- [{key,severity,confidence}] — normalized, never raw payloads
  medical_flags text[] not null default '{}',
  image_refs    text[] not null default '{}',        -- private-bucket storage paths, purged on TTL
  created_at    timestamptz not null default now()
);

create table answers (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id) on delete cascade,
  question_id text not null,
  value       text not null,
  created_at  timestamptz not null default now()
);

create table recommendations (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references sessions(id) on delete cascade,
  routine           jsonb not null,                  -- [{sku,slot,when,score,explanation,...}]
  escalated         boolean not null default false,
  escalation_reason text,
  created_at        timestamptz not null default now()
);

-- No FK on session_id: erasure audit rows must outlive the session they log.
create table audit_log (
  id          bigserial primary key,
  session_id  uuid,
  event       text not null,                         -- CONSENT_GRANT, ANALYZE, ESCALATE, PURGE, DELETE_REQ
  meta        jsonb,
  at          timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Indexes & housekeeping
-- ────────────────────────────────────────────────────────────────────────────

create index consent_session_id_idx         on consent (session_id);
create index analyses_session_id_idx        on analyses (session_id);
create index answers_session_id_idx         on answers (session_id);
create index recommendations_session_id_idx on recommendations (session_id);
create index audit_log_session_id_idx       on audit_log (session_id);
create index sessions_purge_after_idx       on sessions (purge_after);  -- purge job: where purge_after < now()

create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger sessions_set_updated_at
  before update on sessions
  for each row execute function set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
--
-- Access model (§12): the API signs a short-TTL JWT per session with the
-- Supabase JWT secret, carrying `role: 'authenticated'` and a custom
-- `session_id` claim. A browser holding that token can READ its own session's
-- rows and nothing else. ALL writes go through the server with the
-- service-role key (BYPASSRLS) — clients get no insert/update/delete at all.
-- ────────────────────────────────────────────────────────────────────────────

-- The session identity asserted by the signed token. Returns NULL (matches
-- nothing) when the claim is absent or malformed.
create function current_session_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid
$$;

alter table sessions        enable row level security;
alter table consent         enable row level security;
alter table analyses        enable row level security;
alter table answers         enable row level security;
alter table recommendations enable row level security;
alter table audit_log       enable row level security;

create policy sessions_select_own on sessions
  for select to authenticated
  using (id = (select current_session_id()));

create policy consent_select_own on consent
  for select to authenticated
  using (session_id = (select current_session_id()));

create policy analyses_select_own on analyses
  for select to authenticated
  using (session_id = (select current_session_id()));

create policy answers_select_own on answers
  for select to authenticated
  using (session_id = (select current_session_id()));

create policy recommendations_select_own on recommendations
  for select to authenticated
  using (session_id = (select current_session_id()));

-- audit_log: RLS on, NO policies — default-deny. Server-only via service role.

-- Belt-and-braces: even a mistaken future policy can't grant writes if the
-- underlying table privilege is gone.
revoke insert, update, delete on sessions, consent, analyses, answers, recommendations from anon, authenticated;
revoke all on audit_log from anon, authenticated;
