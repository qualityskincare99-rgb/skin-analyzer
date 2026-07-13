/** GET /api/skin/questions — the questions the client should be answering now
 *  (idempotent; supports resume). */

import { handle, json, preflight } from '../_lib/http';
import { getRepo } from '../_lib/deps';
import { requireSession } from '../_lib/auth';
import { loadConsult, toClientQuestions } from '../_lib/flow';

export const OPTIONS = preflight;

export const GET = handle(async (req) => {
  const sessionId = await requireSession(req);
  const snap = await loadConsult(getRepo(), sessionId);
  return json(req, 200, {
    state: snap.session.state,
    questions: toClientQuestions(snap.pending),
  });
});
