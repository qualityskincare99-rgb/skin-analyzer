/**
 * POST /api/skin/feedback — the customer's review of a finished consultation.
 *
 * Which question was asked is decided here, from the session's own state, not
 * from the request body: a session that ended in a dermatologist referral can
 * only ever record a clarity verdict, and one that ended in a routine can only
 * ever record a rating. A client cannot claim otherwise, so the two populations
 * in the table can never blur.
 *
 * Deliberately NOT gated on consent. A review is the customer's own words
 * about the service, not an inference drawn from their face, and
 * `image_analysis` consent has nothing to say about it. It is also why the
 * row outlives the retention purge (see the migration).
 */

import { ApiError, handle, json, preflight, readJson } from '../_lib/http';
import { getRepo } from '../_lib/deps';
import { requireSession } from '../_lib/auth';
import { DuplicateFeedbackError, type FeedbackKind } from '@/lib/db/repo';

export const OPTIONS = preflight;

const MAX_COMMENT = 2000;

/** Only these two states mean the customer has actually seen a result. */
const KIND_FOR_STATE: Partial<Record<string, FeedbackKind>> = {
  PRESENT: 'RECOMMEND',
  ESCALATE: 'ESCALATE',
};

export const POST = handle(async (req) => {
  const sessionId = await requireSession(req);
  const repo = getRepo();

  const session = await repo.getSession(sessionId);
  if (!session) throw new ApiError(404, 'session not found');

  const kind = KIND_FOR_STATE[session.state];
  if (!kind)
    throw new ApiError(409, 'nothing to review yet — finish the consultation first');

  const body = await readJson<{ rating?: unknown; clarity?: unknown; comment?: unknown }>(req);

  let comment: string | undefined;
  if (body.comment !== undefined && body.comment !== null && body.comment !== '') {
    if (typeof body.comment !== 'string') throw new ApiError(400, 'comment must be a string');
    comment = body.comment.trim();
    if (comment.length > MAX_COMMENT)
      throw new ApiError(400, `comment must be ${MAX_COMMENT} characters or fewer`);
    if (comment === '') comment = undefined;
  }

  let rating: number | undefined;
  let clarity: 'clear' | 'unclear' | undefined;

  if (kind === 'RECOMMEND') {
    if (body.clarity !== undefined)
      throw new ApiError(400, 'clarity is only accepted on a dermatologist referral');
    if (!Number.isInteger(body.rating) || (body.rating as number) < 1 || (body.rating as number) > 5)
      throw new ApiError(400, 'rating must be an integer from 1 to 5');
    rating = body.rating as number;
  } else {
    if (body.rating !== undefined)
      throw new ApiError(400, 'rating is not asked for on a dermatologist referral');
    if (body.clarity !== 'clear' && body.clarity !== 'unclear')
      throw new ApiError(400, "clarity must be 'clear' or 'unclear'");
    clarity = body.clarity;
  }

  try {
    const row = await repo.saveFeedback({ sessionId, kind, rating, clarity, comment });
    return json(req, 201, { feedbackId: row.id, kind: row.kind, recordedAt: row.created_at });
  } catch (err) {
    if (err instanceof DuplicateFeedbackError)
      throw new ApiError(409, 'feedback already recorded for this consultation');
    throw err;
  }
});
