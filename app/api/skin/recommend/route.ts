/**
 * POST /api/skin/recommend — final safety gate, then the weighted engine.
 * Returns the same ConsultationResult shape as runConsultation.
 *
 * Shopify hydration (price/availability/URLs, spec §11) is layered on here
 * once /lib/shopify exists — the engine's SKUs are the contract.
 */

import { ApiError, handle, json, preflight } from '../_lib/http';
import { getRepo } from '../_lib/deps';
import { requireSession } from '../_lib/auth';
import { escalateAndPersist, fmtConfidence, loadConsult } from '../_lib/flow';
import { safetyCheck, COSMETIC_DISCLAIMER } from '@/lib/safety/gate';
import { buildRoutine } from '@/lib/reco/engine';
import type { ConsultationResult } from '@/lib/orchestrator';

export const OPTIONS = preflight;

export const POST = handle(async (req) => {
  const sessionId = await requireSession(req);
  const repo = getRepo();
  const snap = await loadConsult(repo, sessionId);

  const state = snap.session.state;
  if (state === 'ESCALATE')
    throw new ApiError(409, 'consultation escalated — dermatologist referral, no products');
  if (state === 'PRESENT') throw new ApiError(409, 'recommendation already generated');
  if (state !== 'RECOMMEND')
    throw new ApiError(409, `not ready to recommend (state ${state}) — answer pending questions first`);

  // Belt-and-braces: the gate runs before any product is shown, same as the
  // orchestrator re-checking answers it already saw.
  const safety = safetyCheck(snap.current, snap.answered);
  if (safety.escalate)
    return json(req, 200, await escalateAndPersist(repo, sessionId, safety, snap.questionsAsked));

  const result: ConsultationResult = {
    route: 'RECOMMEND',
    confidence: fmtConfidence(snap.confidence),
    questionsAsked: snap.questionsAsked,
    concerns: snap.current.concerns,
    routine: buildRoutine(snap.current),
    disclaimer: COSMETIC_DISCLAIMER,
  };
  await repo.saveRecommendation({ sessionId, result });
  await repo.updateSessionState(sessionId, 'PRESENT');
  return json(req, 200, result);
});
