/**
 * In-memory SkinRepo — testing-ladder stage 1 (spec §14: "local, mock vision
 * provider — no vendor, no store"). Same contract and side effects as the
 * Supabase repo so the API layer can't tell the difference.
 *
 * Process-local: every restart wipes it. Not wired into the API — deps.ts
 * refuses to run without real Supabase env. Kept for explicit use in unit-test
 * harnesses that want the repo contract without a database.
 */

import { randomUUID } from 'node:crypto';
import type {
  AnalysisRow, AnswerRow, AuditEvent, ConsentRow, ConsentScope,
  FeedbackRow, RecommendationRow, SessionRow, SessionState, SkinRepo,
} from './repo';
import { DuplicateFeedbackError } from './repo';

const ALLOWED_SCOPES: ConsentScope[] = ['image_analysis', 'store_results', 'marketing'];

export function createMemoryRepo(): SkinRepo {
  const sessions = new Map<string, SessionRow>();
  const consent: ConsentRow[] = [];
  const analyses: AnalysisRow[] = [];
  const answers: AnswerRow[] = [];
  const recommendations: RecommendationRow[] = [];
  const feedback: FeedbackRow[] = [];
  const auditLog: { event: AuditEvent; session_id: string | null; meta: Record<string, unknown>; at: string }[] = [];

  const now = () => new Date().toISOString();

  function mustSession(id: string, op: string): SessionRow {
    const s = sessions.get(id);
    if (!s) throw new Error(`repo.${op}: session ${id} not found`);
    return s;
  }

  return {
    async logAudit(event, sessionId, meta = {}) {
      auditLog.push({ event, session_id: sessionId, meta, at: now() });
    },

    async createSession(input = {}) {
      const t = now();
      const row: SessionRow = {
        id: randomUUID(),
        shopify_customer_id: input.shopifyCustomerId ?? null,
        state: 'INIT',
        skin_type: null,
        skin_type_conf: null,
        route: null,
        created_at: t,
        updated_at: t,
        purge_after: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      sessions.set(row.id, row);
      return { ...row };
    },

    async recordConsent({ sessionId, scope, ipHash }) {
      if (scope.length === 0) throw new Error('repo.recordConsent: empty consent scope');
      if (scope.some(s => !ALLOWED_SCOPES.includes(s)))
        throw new Error('repo.recordConsent: unknown consent scope');
      mustSession(sessionId, 'recordConsent');
      const row: ConsentRow = {
        id: randomUUID(),
        session_id: sessionId,
        scope: [...scope],
        ip_hash: ipHash ?? null,
        granted_at: now(),
        revoked_at: null,
      };
      consent.push(row);
      await this.logAudit('CONSENT_GRANT', sessionId, { scope });
      return { ...row };
    },

    async saveAnalysis({ sessionId, assessment, imageRefs }) {
      const session = mustSession(sessionId, 'saveAnalysis');
      // Same privacy invariant as the Supabase repo: only normalized fields.
      const { provider, imageQualityScore, concerns, medicalFlags, skinType } = assessment;
      const row: AnalysisRow = {
        id: randomUUID(),
        session_id: sessionId,
        provider,
        image_quality: imageQualityScore,
        concerns: JSON.parse(JSON.stringify(concerns)),
        medical_flags: [...medicalFlags],
        image_refs: [...(imageRefs ?? [])],
        created_at: now(),
      };
      analyses.push(row);
      session.skin_type = skinType.value;
      session.skin_type_conf = skinType.confidence;
      session.updated_at = now();
      await this.logAudit('ANALYZE', sessionId, { provider, image_quality: imageQualityScore });
      return { ...row };
    },

    async saveAnswers({ sessionId, answers: batch }) {
      mustSession(sessionId, 'saveAnswers');
      const rows = Object.entries(batch)
        .filter(([, value]) => value !== '')
        .map(([question_id, value]): AnswerRow => ({
          id: randomUUID(),
          session_id: sessionId,
          question_id,
          value,
          created_at: now(),
        }));
      answers.push(...rows);
      return rows.map(r => ({ ...r }));
    },

    async saveRecommendation({ sessionId, result }) {
      const session = mustSession(sessionId, 'saveRecommendation');
      const escalated = result.route === 'ESCALATE';
      const row: RecommendationRow = {
        id: randomUUID(),
        session_id: sessionId,
        routine: JSON.parse(JSON.stringify(result.routine)),
        escalated,
        escalation_reason: result.escalationReason ?? null,
        created_at: now(),
      };
      recommendations.push(row);
      session.route = result.route as SessionRow['route'];
      session.state = escalated ? 'ESCALATE' : 'RECOMMEND';
      session.updated_at = now();
      if (escalated) await this.logAudit('ESCALATE', sessionId, { reason: result.escalationReason });
      return { ...row };
    },

    async saveFeedback({ sessionId, kind, rating, clarity, comment }) {
      // Mirrors the unique index in the migration, so both repos reject a
      // second review the same way.
      if (feedback.some(f => f.session_id === sessionId)) throw new DuplicateFeedbackError(sessionId);
      const row: FeedbackRow = {
        id: randomUUID(),
        session_id: sessionId,
        kind,
        rating: rating ?? null,
        clarity: clarity ?? null,
        comment: comment ?? null,
        extra: {},
        created_at: now(),
      };
      feedback.push(row);
      return { ...row };
    },

    async getFeedback(sessionId) {
      const row = feedback.find(f => f.session_id === sessionId);
      return row ? { ...row } : null;
    },

    async listExpiredSessions({ now, limit } = {}) {
      const cutoff = (now ?? new Date()).toISOString();
      return [...sessions.values()]
        .filter(s => s.purge_after < cutoff)
        .sort((a, b) => a.purge_after.localeCompare(b.purge_after))
        .slice(0, limit ?? 500)
        .map(s => ({
          id: s.id,
          purgeAfter: s.purge_after,
          imageRefs: analyses.filter(a => a.session_id === s.id).flatMap(a => a.image_refs),
          scopes: [
            ...new Set(
              consent.filter(c => c.session_id === s.id && !c.revoked_at).flatMap(c => c.scope),
            ),
          ],
        }));
    },

    async purgeImages(sessionId, refs) {
      // No storage in memory mode; clearing the refs is the whole observable
      // effect, same as the real repo once the bucket delete has returned.
      for (const a of analyses) if (a.session_id === sessionId) a.image_refs = [];
      return refs.length;
    },

    async deleteAllForSession(sessionId) {
      const refs = analyses.filter(a => a.session_id === sessionId).flatMap(a => a.image_refs);
      // No storage in memory mode — refs counted for parity with the real repo.
      sessions.delete(sessionId);
      const drop = <T extends { session_id: string }>(arr: T[]) => {
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i].session_id === sessionId) arr.splice(i, 1);
      };
      // feedback has no cascade in the real schema either; erasure takes it
      // explicitly while the retention purge leaves it alone.
      drop(consent); drop(analyses); drop(answers); drop(recommendations); drop(feedback);
      await this.logAudit('DELETE_REQ', sessionId, { images_removed: refs.length });
      return { imagesRemoved: refs.length };
    },

    async getSession(id) {
      const s = sessions.get(id);
      return s ? { ...s } : null;
    },

    async getConsent(sessionId) {
      return consent.filter(c => c.session_id === sessionId).map(c => ({ ...c }));
    },

    async getLatestAnalysis(sessionId) {
      const rows = analyses.filter(a => a.session_id === sessionId);
      const last = rows[rows.length - 1];
      return last ? { ...last } : null;
    },

    async getAnswers(sessionId) {
      return answers.filter(a => a.session_id === sessionId).map(a => ({ ...a }));
    },

    async updateSessionState(id, state: SessionState) {
      const session = mustSession(id, 'updateSessionState');
      session.state = state;
      session.updated_at = now();
    },
  };
}
