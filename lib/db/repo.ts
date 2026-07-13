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

export function createRepo(db: SupabaseClient) {
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

    const { error: deleteError } = await db.from('sessions').delete().eq('id', sessionId);
    if (deleteError) fail('deleteAllForSession(rows)', deleteError);

    await logAudit('DELETE_REQ', sessionId, { images_removed: refs.length });
    return { imagesRemoved: refs.length };
  }

  return {
    createSession,
    recordConsent,
    saveAnalysis,
    saveAnswers,
    saveRecommendation,
    deleteAllForSession,
    logAudit,
  };
}

export type SkinRepo = ReturnType<typeof createRepo>;
