/**
 * POST /api/skin/analyze — run the vision provider, then GATE 1 (image-level
 * medical flags) and GATE 2 setup (triage) exactly as runConsultation does.
 *
 * Frame upload + quality gate re-validation land with the real provider
 * adapter (spec §3/§4); the mock provider takes `mockAssessment` instead
 * (testing ladder stages 1–2) and no image ever exists, hence imageRefs [].
 */

import { ApiError, handle, json, preflight, readJson } from '../_lib/http';
import { getRepo, getVisionProvider } from '../_lib/deps';
import { requireSession } from '../_lib/auth';
import { escalateAndPersist, fmtConfidence, loadConsult, toClientQuestions } from '../_lib/flow';
import { safetyCheck } from '@/lib/safety/gate';

export const OPTIONS = preflight;

export const POST = handle(async (req) => {
  const sessionId = await requireSession(req);
  const repo = getRepo();

  const session = await repo.getSession(sessionId);
  if (!session) throw new ApiError(404, 'session not found');
  if (await repo.getLatestAnalysis(sessionId))
    throw new ApiError(409, 'session already analyzed — start a new session to retake');

  // Consent-first (spec §12): hard requirement, checked server-side.
  const consents = await repo.getConsent(sessionId);
  const canAnalyze = consents.some(c => !c.revoked_at && c.scope.includes('image_analysis'));
  if (!canAnalyze) throw new ApiError(403, "consent with scope 'image_analysis' required before analysis");

  const body = await readJson<{ mockAssessment?: unknown }>(req);
  const provider = getVisionProvider(body.mockAssessment);
  const assessment = await provider.analyze(null);
  await repo.saveAnalysis({ sessionId, assessment, imageRefs: [] });

  // ── GATE 1: raw image flags, before anything else.
  const gate1 = safetyCheck(assessment, {});
  if (gate1.escalate) return json(req, 200, await escalateAndPersist(repo, sessionId, gate1, []));

  const snap = await loadConsult(repo, sessionId);

  // ── GATE 2 setup: triage questions come before the main consult.
  if (snap.triage.length > 0) {
    await repo.updateSessionState(sessionId, 'TRIAGE');
    return json(req, 200, { state: 'TRIAGE', questions: toClientQuestions(snap.triage) });
  }

  await repo.updateSessionState(sessionId, snap.route);
  return json(req, 200, {
    state: snap.route,
    route: snap.route,
    confidence: fmtConfidence(snap.confidence),
    questions: toClientQuestions(snap.mainQuestions),
  });
});
