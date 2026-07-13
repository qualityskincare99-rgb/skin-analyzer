/**
 * Stateless consult-flow derivation. `runConsultation` (lib/orchestrator.ts)
 * drives the whole flow in one call with an answer callback; over HTTP the
 * same sequence spans several requests. Rather than caching a mutated
 * assessment between requests, every request re-derives the exact orchestrator
 * state from what's persisted: the original analysis plus the answer rows.
 *
 * Equivalence to runConsultation is exact, not approximate: the state machine
 * allows one answer round per phase, so replaying [triage batch] then
 * [main batch] through applyAnswers reproduces the orchestrator's two passes
 * verbatim. All engine calls below are the untouched lib modules.
 */

import type { Question } from '@/lib/questions/bank';
import { triageQuestions } from '@/lib/questions/triage';
import { applyAnswers, selectQuestions } from '@/lib/questions/select';
import { routeByConfidence, type Route } from '@/lib/confidence/router';
import { DERM_REFERRAL } from '@/lib/safety/gate';
import type { SkinAssessment, SkinType } from '@/lib/vision/types';
import type { ConsultationResult } from '@/lib/orchestrator';
import type { AnalysisRow, SessionRow, SkinRepo } from '@/lib/db/repo';
import { ApiError } from './http';

/** What the client sees. `effects` and `safetyScreen` stay server-side: they
 *  encode scoring internals and which option triggers a medical escalation. */
export interface ClientQuestion {
  id: string;
  text: string;
  options: { label: string; value: string }[];
}

export function toClientQuestions(questions: Question[]): ClientQuestion[] {
  return questions.map(q => ({
    id: q.id,
    text: q.text,
    options: q.options.map(o => ({ label: o.label, value: o.value })),
  }));
}

export const fmtConfidence = (n: number) => Number(n.toFixed(3));

export interface ConsultSnapshot {
  session: SessionRow;
  /** Assessment as the vision provider returned it. */
  base: SkinAssessment;
  /** Triage questions the base assessment warrants (deterministic). */
  triage: Question[];
  /** All persisted answers, latest value per question. */
  answered: Record<string, string>;
  /** base + triage answers — what the orchestrator routes on. */
  postTriage: SkinAssessment;
  /** postTriage + main answers — what the routine is built from. */
  current: SkinAssessment;
  route: Route;
  /** Re-scored once after the main round, exactly like the orchestrator. */
  confidence: number;
  /** CLARIFY/CONSULT selection from postTriage, minus already-asked triage. */
  mainQuestions: Question[];
  /** Questions the client should be answering right now, per session state. */
  pending: Question[];
  questionsAsked: string[];
}

function assessmentFromRows(session: SessionRow, analysis: AnalysisRow): SkinAssessment {
  if (!session.skin_type || session.skin_type_conf === null)
    throw new ApiError(500, 'session missing skin type after analysis — data integrity error');
  return {
    provider: analysis.provider,
    imageQualityScore: analysis.image_quality ?? 0,
    medicalFlags: analysis.medical_flags,
    concerns: analysis.concerns,
    skinType: { value: session.skin_type as SkinType, confidence: session.skin_type_conf },
  };
}

export async function loadConsult(repo: SkinRepo, sessionId: string): Promise<ConsultSnapshot> {
  const session = await repo.getSession(sessionId);
  if (!session) throw new ApiError(404, 'session not found');
  const analysis = await repo.getLatestAnalysis(sessionId);
  if (!analysis) throw new ApiError(409, 'no analysis yet — POST /api/skin/analyze first');

  const base = assessmentFromRows(session, analysis);

  const answered: Record<string, string> = {};
  for (const row of await repo.getAnswers(sessionId)) answered[row.question_id] = row.value;

  const triage = triageQuestions(base);
  const triageIds = new Set(triage.map(q => q.id));
  const triageAnswers: Record<string, string> = {};
  const mainAnswers: Record<string, string> = {};
  for (const [id, value] of Object.entries(answered))
    (triageIds.has(id) ? triageAnswers : mainAnswers)[id] = value;

  const postTriage = applyAnswers(base, triageAnswers);
  const routed = routeByConfidence(postTriage);
  const mainQuestions = routed.route === 'RECOMMEND'
    ? []
    : selectQuestions(postTriage, routed.route === 'CONSULT' ? 5 : 3).filter(q => !triageIds.has(q.id));

  const current = applyAnswers(postTriage, mainAnswers);
  const hasMainAnswers = Object.keys(mainAnswers).length > 0;
  const confidence = hasMainAnswers ? routeByConfidence(current).confidence : routed.confidence;

  const state = session.state;
  const pending = state === 'TRIAGE' ? triage
    : state === 'CLARIFY' || state === 'CONSULT' ? mainQuestions
    : [];
  const questionsAsked = state === 'TRIAGE' || state === 'ESCALATE'
    ? triage.map(q => q.id)
    : ['CLARIFY', 'CONSULT', 'RECOMMEND', 'PRESENT'].includes(state)
      ? [...triage.map(q => q.id), ...mainQuestions.map(q => q.id)]
      : [];

  return {
    session, base, triage, answered, postTriage, current,
    route: routed.route, confidence, mainQuestions, pending, questionsAsked,
  };
}

/**
 * Mirror of the orchestrator's `escalate()` plus persistence: zero products,
 * dermatologist referral, audit trail, session locked in ESCALATE.
 */
export async function escalateAndPersist(
  repo: SkinRepo,
  sessionId: string,
  safety: { reason?: string; message?: string },
  questionsAsked: string[],
): Promise<ConsultationResult> {
  const result: ConsultationResult = {
    route: 'ESCALATE',
    confidence: 0,
    escalationReason: safety.reason,
    questionsAsked,
    routine: [],
    disclaimer: safety.message ?? DERM_REFERRAL,
  };
  await repo.saveRecommendation({ sessionId, result });
  return result;
}
