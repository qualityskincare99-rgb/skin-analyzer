/**
 * Typed persistence layer over Supabase (spec §9 schema, §12 privacy).
 *
 * SERVER-ONLY. Instantiate with a service-role client — RLS gives browser
 * tokens read-only access to their own session's rows, so every write here
 * MUST run with the service key (which never reaches the client).
 *
 * Privacy invariant: nothing in this file persists raw provider payloads or
 * image bytes. `analyses` stores the normalized assessment plus private-bucket
 * storage paths only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConcernScore, SkinAssessment } from '../vision/types';
import type { RoutineItem } from '../reco/engine';
import type { ConsultationResult } from '../orchestrator';

/** Private storage bucket for capture frames. Never expose public URLs. */
export const IMAGE_BUCKET = 'skin-captures';

export type ConsentScope = 'image_analysis' | 'store_results' | 'marketing';

/** Consultation state machine states (spec §2). */
export type SessionState =
  | 'INIT' | 'CAPTURE' | 'ANALYZING' | 'TRIAGE'
  | 'CLARIFY' | 'CONSULT' | 'RECOMMEND' | 'ESCALATE' | 'PRESENT';

export type AuditEvent = 'CONSENT_GRANT' | 'ANALYZE' | 'ESCALATE' | 'PURGE' | 'DELETE_REQ';

// Row shapes as returned by Postgres (timestamps arrive as ISO strings).

export interface SessionRow {
  id: string;
  shopify_customer_id: string | null;
  state: SessionState;
  skin_type: string | null;
  skin_type_conf: number | null;
  route: 'RECOMMEND' | 'CLARIFY' | 'CONSULT' | 'ESCALATE' | null;
  created_at: string;
  updated_at: string;
  purge_after: string;
}

export interface ConsentRow {
  id: string;
  session_id: string;
  scope: ConsentScope[];
  ip_hash: string | null;
  granted_at: string;
  revoked_at: string | null;
}

export interface AnalysisRow {
  id: string;
  session_id: string;
  provider: string;
  image_quality: number | null;
  concerns: ConcernScore[];
  medical_flags: string[];
  image_refs: string[];
  created_at: string;
}

export interface AnswerRow {
  id: string;
  session_id: string;
  question_id: string;
  value: string;
  created_at: string;
}

export interface RecommendationRow {
  id: string;
  session_id: string;
  routine: RoutineItem[];
  escalated: boolean;
  escalation_reason: string | null;
  created_at: string;
}

export type FeedbackKind = 'RECOMMEND' | 'ESCALATE';

export interface FeedbackRow {
  id: string;
  session_id: string;
  kind: FeedbackKind;
  rating: number | null;
  clarity: 'clear' | 'unclear' | null;
  comment: string | null;
  extra: Record<string, unknown>;
  created_at: string;
}

export interface FeedbackInput {
  sessionId: string;
  kind: FeedbackKind;
  /** 1-5, RECOMMEND only. */
  rating?: number;
  /** ESCALATE only: did the referral land. */
  clarity?: 'clear' | 'unclear';
  comment?: string;
}

/**
 * One session past its `purge_after`, with everything the retention policy
 * needs to decide what to do with it. `scopes` is the union of every
 * un-revoked consent grant on the session.
 */
export interface ExpiredSession {
  id: string;
  purgeAfter: string;
  imageRefs: string[];
  scopes: ConsentScope[];
}

/**
 * The persistence contract the API layer codes against. Two implementations:
 * `createRepo` (Supabase, production) and `createMemoryRepo` (lib/db/memory.ts,
 * testing-ladder stage 1 — local, no store).
 */
export interface SkinRepo {
  createSession(input?: { shopifyCustomerId?: string }): Promise<SessionRow>;
  recordConsent(input: { sessionId: string; scope: ConsentScope[]; ipHash?: string }): Promise<ConsentRow>;
  saveAnalysis(input: { sessionId: string; assessment: SkinAssessment; imageRefs?: string[] }): Promise<AnalysisRow>;
  saveAnswers(input: { sessionId: string; answers: Record<string, string> }): Promise<AnswerRow[]>;
  saveRecommendation(input: { sessionId: string; result: ConsultationResult }): Promise<RecommendationRow>;
  deleteAllForSession(sessionId: string): Promise<{ imagesRemoved: number }>;
  listExpiredSessions(opts?: { now?: Date; limit?: number }): Promise<ExpiredSession[]>;
  saveFeedback(input: FeedbackInput): Promise<FeedbackRow>;
  getFeedback(sessionId: string): Promise<FeedbackRow | null>;
  purgeImages(sessionId: string, refs: string[]): Promise<number>;
  logAudit(event: AuditEvent, sessionId: string | null, meta?: Record<string, unknown>): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  getConsent(sessionId: string): Promise<ConsentRow[]>;
  getLatestAnalysis(sessionId: string): Promise<AnalysisRow | null>;
  getAnswers(sessionId: string): Promise<AnswerRow[]>;
  updateSessionState(id: string, state: SessionState): Promise<void>;
}

/** Thrown when a session already has a review. The route turns it into a 409. */
export class DuplicateFeedbackError extends Error {
  constructor(sessionId: string) {
    super(`feedback already recorded for session ${sessionId}`);
    this.name = 'DuplicateFeedbackError';
  }
}

export function createRepo(db: SupabaseClient): SkinRepo {
  function fail(op: string, error: { message: string }): never {
    throw new Error(`repo.${op}: ${error.message}`);
  }

  async function logAudit(
    event: AuditEvent,
    sessionId: string | null,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await db.from('audit_log').insert({ session_id: sessionId, event, meta });
    if (error) fail(`logAudit(${event})`, error);
  }

  async function createSession(
    input: { shopifyCustomerId?: string } = {},
  ): Promise<SessionRow> {
    const { data, error } = await db
      .from('sessions')
      .insert({ shopify_customer_id: input.shopifyCustomerId ?? null })
      .select()
      .single();
    if (error) fail('createSession', error);
    return data as SessionRow;
  }

  async function recordConsent(input: {
    sessionId: string;
    scope: ConsentScope[];
    ipHash?: string;
  }): Promise<ConsentRow> {
    if (input.scope.length === 0) throw new Error('repo.recordConsent: empty consent scope');
    const { data, error } = await db
      .from('consent')
      .insert({ session_id: input.sessionId, scope: input.scope, ip_hash: input.ipHash ?? null })
      .select()
      .single();
    if (error) fail('recordConsent', error);
    await logAudit('CONSENT_GRANT', input.sessionId, { scope: input.scope });
    return data as ConsentRow;
  }

  async function saveAnalysis(input: {
    sessionId: string;
    assessment: SkinAssessment;
    imageRefs?: string[];
  }): Promise<AnalysisRow> {
    // Explicit destructure: only the normalized fields can reach the row, so a
    // provider adapter that leaks a raw payload on the assessment can't leak
    // it into Postgres.
    const { provider, imageQualityScore, concerns, medicalFlags, skinType } = input.assessment;
    const { data, error } = await db
      .from('analyses')
      .insert({
        session_id: input.sessionId,
        provider,
        image_quality: imageQualityScore,
        concerns,
        medical_flags: medicalFlags,
        image_refs: input.imageRefs ?? [],
      })
      .select()
      .single();
    if (error) fail('saveAnalysis', error);

    const { error: sessionError } = await db
      .from('sessions')
      .update({ skin_type: skinType.value, skin_type_conf: skinType.confidence })
      .eq('id', input.sessionId);
    if (sessionError) fail('saveAnalysis(session)', sessionError);

    await logAudit('ANALYZE', input.sessionId, { provider, image_quality: imageQualityScore });
    return data as AnalysisRow;
  }

  async function saveAnswers(input: {
    sessionId: string;
    answers: Record<string, string>;
  }): Promise<AnswerRow[]> {
    const rows = Object.entries(input.answers)
      .filter(([, value]) => value !== '')
      .map(([question_id, value]) => ({ session_id: input.sessionId, question_id, value }));
    if (rows.length === 0) return [];
    const { data, error } = await db.from('answers').insert(rows).select();
    if (error) fail('saveAnswers', error);
    return data as AnswerRow[];
  }

  async function saveRecommendation(input: {
    sessionId: string;
    result: ConsultationResult;
  }): Promise<RecommendationRow> {
    const escalated = input.result.route === 'ESCALATE';
    const { data, error } = await db
      .from('recommendations')
      .insert({
        session_id: input.sessionId,
        routine: input.result.routine,
        escalated,
        escalation_reason: input.result.escalationReason ?? null,
      })
      .select()
      .single();
    if (error) fail('saveRecommendation', error);

    const { error: sessionError } = await db
      .from('sessions')
      .update({ route: input.result.route, state: escalated ? 'ESCALATE' : 'RECOMMEND' })
      .eq('id', input.sessionId);
    if (sessionError) fail('saveRecommendation(session)', sessionError);

    if (escalated)
      await logAudit('ESCALATE', input.sessionId, { reason: input.result.escalationReason });
    return data as RecommendationRow;
  }

  /**
   * Record the customer's review of a finished consultation.
   *
   * A unique index on session_id makes one-per-session a database fact rather
   * than a route convention, so a double-tapped submit button cannot produce
   * two rows. 23505 is that index firing; it surfaces as a clean 409 upstream
   * instead of a 500.
   */
  async function saveFeedback(input: FeedbackInput): Promise<FeedbackRow> {
    const { data, error } = await db
      .from('feedback')
      .insert({
        session_id: input.sessionId,
        kind: input.kind,
        rating: input.rating ?? null,
        clarity: input.clarity ?? null,
        comment: input.comment ?? null,
      })
      .select()
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505')
        throw new DuplicateFeedbackError(input.sessionId);
      fail('saveFeedback', error);
    }
    return data as FeedbackRow;
  }

  async function getFeedback(sessionId: string): Promise<FeedbackRow | null> {
    const { data, error } = await db
      .from('feedback').select().eq('session_id', sessionId).maybeSingle();
    if (error) fail('getFeedback', error);
    return (data as FeedbackRow | null) ?? null;
  }

  /**
   * Sessions whose retention window has closed. Oldest first and capped, so
   * one purge run is a bounded unit of work: a backlog drains over several
   * ticks instead of one run timing out halfway and leaving storage and rows
   * disagreeing about what exists.
   */
  async function listExpiredSessions(
    opts: { now?: Date; limit?: number } = {},
  ): Promise<ExpiredSession[]> {
    const cutoff = (opts.now ?? new Date()).toISOString();
    const { data, error } = await db
      .from('sessions')
      .select('id, purge_after, analyses(image_refs), consent(scope, revoked_at)')
      .lt('purge_after', cutoff)
      .order('purge_after', { ascending: true })
      .limit(opts.limit ?? 500);
    if (error) fail('listExpiredSessions', error);

    type Joined = {
      id: string;
      purge_after: string;
      analyses: { image_refs: string[] | null }[] | null;
      consent: { scope: ConsentScope[] | null; revoked_at: string | null }[] | null;
    };

    return (data as Joined[]).map(row => ({
      id: row.id,
      purgeAfter: row.purge_after,
      imageRefs: (row.analyses ?? []).flatMap(a => a.image_refs ?? []),
      scopes: [...new Set((row.consent ?? []).filter(c => !c.revoked_at).flatMap(c => c.scope ?? []))],
    }));
  }

  /**
   * Drop one session's capture frames and forget where they were.
   *
   * Storage first, then `image_refs`. If the process dies between the two,
   * the row still points at already-deleted objects and the next run retries
   * a harmless no-op delete. The other order would leave live image files in
   * the bucket with nothing in the database pointing at them, which is the
   * one outcome a deletion promise cannot survive.
   */
  async function purgeImages(sessionId: string, refs: string[]): Promise<number> {
    if (refs.length > 0) {
      const { error } = await db.storage.from(IMAGE_BUCKET).remove(refs);
      if (error) fail('purgeImages(storage)', error);
    }
    const { error: clearError } = await db
      .from('analyses')
      .update({ image_refs: [] })
      .eq('session_id', sessionId);
    if (clearError) fail('purgeImages(refs)', clearError);
    return refs.length;
  }

  /**
   * Right-to-erasure (§12): storage objects first (their paths are gone once
   * the analyses rows cascade), then the session row — consent, analyses,
   * answers, and recommendations all cascade off it. The audit entry survives
   * by design (no FK on audit_log.session_id).
   */
  async function deleteAllForSession(sessionId: string): Promise<{ imagesRemoved: number }> {
    const { data: rows, error } = await db
      .from('analyses')
      .select('image_refs')
      .eq('session_id', sessionId);
    if (error) fail('deleteAllForSession(refs)', error);

    const refs = (rows as Pick<AnalysisRow, 'image_refs'>[]).flatMap(r => r.image_refs ?? []);
    if (refs.length > 0) {
      const { error: storageError } = await db.storage.from(IMAGE_BUCKET).remove(refs);
      if (storageError) fail('deleteAllForSession(storage)', storageError);
    }

    // `feedback` carries no FK to sessions on purpose (it must survive the
    // retention purge), so the cascade will not take it. An erasure request
    // is the one case where it must go, so delete it explicitly.
    const { error: feedbackError } = await db.from('feedback').delete().eq('session_id', sessionId);
    if (feedbackError) fail('deleteAllForSession(feedback)', feedbackError);

    const { error: deleteError } = await db.from('sessions').delete().eq('id', sessionId);
    if (deleteError) fail('deleteAllForSession(rows)', deleteError);

    await logAudit('DELETE_REQ', sessionId, { images_removed: refs.length });
    return { imagesRemoved: refs.length };
  }

  async function getSession(id: string): Promise<SessionRow | null> {
    const { data, error } = await db.from('sessions').select().eq('id', id).maybeSingle();
    if (error) fail('getSession', error);
    return (data as SessionRow | null) ?? null;
  }

  async function getConsent(sessionId: string): Promise<ConsentRow[]> {
    const { data, error } = await db
      .from('consent')
      .select()
      .eq('session_id', sessionId)
      .order('granted_at', { ascending: true });
    if (error) fail('getConsent', error);
    return data as ConsentRow[];
  }

  async function getLatestAnalysis(sessionId: string): Promise<AnalysisRow | null> {
    const { data, error } = await db
      .from('analyses')
      .select()
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail('getLatestAnalysis', error);
    return (data as AnalysisRow | null) ?? null;
  }

  async function getAnswers(sessionId: string): Promise<AnswerRow[]> {
    const { data, error } = await db
      .from('answers')
      .select()
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) fail('getAnswers', error);
    return data as AnswerRow[];
  }

  async function updateSessionState(id: string, state: SessionState): Promise<void> {
    const { error } = await db.from('sessions').update({ state }).eq('id', id);
    if (error) fail('updateSessionState', error);
  }

  return {
    createSession,
    recordConsent,
    saveAnalysis,
    saveAnswers,
    saveRecommendation,
    deleteAllForSession,
    listExpiredSessions,
    purgeImages,
    saveFeedback,
    getFeedback,
    logAudit,
    getSession,
    getConsent,
    getLatestAnalysis,
    getAnswers,
    updateSessionState,
  };
}
