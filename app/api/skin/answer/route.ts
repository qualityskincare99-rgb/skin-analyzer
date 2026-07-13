/**
 * POST /api/skin/answer — submit one round of answers, advance the state
 * machine. Mirrors runConsultation: the safety gate runs on the incoming
 * batch BEFORE it is applied, so an escalating answer never becomes part of
 * the scored assessment.
 */

import { ApiError, handle, json, preflight, readJson } from '../_lib/http';
import { getRepo } from '../_lib/deps';
import { requireSession } from '../_lib/auth';
import { escalateAndPersist, fmtConfidence, loadConsult, toClientQuestions } from '../_lib/flow';
import { safetyCheck } from '@/lib/safety/gate';

export const OPTIONS = preflight;

export const POST = handle(async (req) => {
  const sessionId = await requireSession(req);
  const repo = getRepo();
  const snap = await loadConsult(repo, sessionId);

  const state = snap.session.state;
  if (state === 'ESCALATE') throw new ApiError(409, 'consultation escalated — no further steps');
  if (state !== 'TRIAGE' && state !== 'CLARIFY' && state !== 'CONSULT')
    throw new ApiError(409, `no answers expected in state ${state}`);

  const body = await readJson<{ answers?: unknown }>(req);
  const answers = body.answers;
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers))
    throw new ApiError(400, 'answers must be an object of questionId → optionValue');

  // Answers are only valid for currently pending questions, with values from
  // the question's own options. Anything else is a client bug — fail loud.
  const pendingById = new Map(snap.pending.map(q => [q.id, q]));
  for (const [questionId, value] of Object.entries(answers)) {
    const question = pendingById.get(questionId);
    if (!question) throw new ApiError(400, `question '${questionId}' is not pending`);
    if (typeof value !== 'string' || !question.options.some(o => o.value === value))
      throw new ApiError(400, `invalid answer value for '${questionId}'`);
  }
  const batch = answers as Record<string, string>;

  // Safety gate on the batch before applying it (orchestrator parity: the
  // triage batch is checked against the base assessment, the main batch
  // against the post-triage assessment).
  const preBatch = state === 'TRIAGE' ? snap.base : snap.postTriage;
  const safety = safetyCheck(preBatch, batch);
  if (safety.escalate)
    return json(req, 200, await escalateAndPersist(repo, sessionId, safety, snap.questionsAsked));

  await repo.saveAnswers({ sessionId, answers: batch });
  const after = await loadConsult(repo, sessionId);

  if (state === 'TRIAGE') {
    // Route is computed on the triage-adjusted assessment, like the orchestrator.
    await repo.updateSessionState(sessionId, after.route);
    return json(req, 200, {
      state: after.route,
      route: after.route,
      confidence: fmtConfidence(after.confidence),
      questions: toClientQuestions(after.route === 'RECOMMEND' ? [] : after.mainQuestions),
    });
  }

  // CLARIFY / CONSULT: one round only, then re-score once and move on.
  await repo.updateSessionState(sessionId, 'RECOMMEND');
  return json(req, 200, {
    state: 'RECOMMEND',
    confidence: fmtConfidence(after.confidence),
    questions: [],
  });
});
