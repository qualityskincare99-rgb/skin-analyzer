import type { SkinVisionProvider } from './vision/provider';
import type { Question } from './questions/bank';
import { triageQuestions } from './questions/triage';
import { selectQuestions, applyAnswers } from './questions/select';
import { safetyCheck, DERM_REFERRAL, COSMETIC_DISCLAIMER } from './safety/gate';
import { routeByConfidence } from './confidence/router';
import { buildRoutine, type RoutineItem } from './reco/engine';

export interface ConsultationResult {
  route: 'RECOMMEND' | 'CLARIFY' | 'CONSULT' | 'ESCALATE';
  confidence: number;
  escalationReason?: string;
  questionsAsked: string[];
  routine: RoutineItem[];
  disclaimer: string;
}

/**
 * Runs the full consultation. `answerFn` simulates the UI: given the questions
 * the engine wants to ask, return the user's answers. In production this is the
 * round-trip through /questions and /answer.
 */
export async function runConsultation(
  provider: SkinVisionProvider,
  answerFn: (questions: Question[]) => Record<string, string> = () => ({}),
): Promise<ConsultationResult> {
  let assessment = await provider.analyze(null);
  const asked: string[] = [];

  // ── GATE 1: raw image flags, before anything else.
  let safety = safetyCheck(assessment, {});
  if (safety.escalate) return escalate(safety);

  // ── GATE 2: TRIAGE. Ask the 1-2 questions that could send this user to a derm
  // BEFORE the full consult, so nobody sits through 7 questions to be told "go see
  // a doctor". Only fires when the assessment actually warrants it.
  const triage = triageQuestions(assessment);
  if (triage.length) {
    asked.push(...triage.map(q => q.id));
    const triageAnswers = answerFn(triage);
    safety = safetyCheck(assessment, triageAnswers);
    if (safety.escalate) return escalate(safety, asked);
    assessment = applyAnswers(assessment, triageAnswers);
  }

  // ── Main consult.
  let { route, confidence } = routeByConfidence(assessment);

  if (route !== 'RECOMMEND') {
    const questions = selectQuestions(assessment, route === 'CONSULT' ? 5 : 3)
      .filter(q => !asked.includes(q.id));                     // don't re-ask triage Qs
    asked.push(...questions.map(q => q.id));
    const answers = answerFn(questions);

    safety = safetyCheck(assessment, answers);                 // belt-and-braces
    if (safety.escalate) return escalate(safety, asked);

    assessment = applyAnswers(assessment, answers);
    ({ confidence } = routeByConfidence(assessment));          // re-score once
  }

  // We've asked what we needed and we're showing products — the session RECOMMENDED.
  // (Previously this leaked 'CLARIFY' into the result and corrupted funnel analytics.)
  return {
    route: 'RECOMMEND',
    confidence: Number(confidence.toFixed(3)),
    questionsAsked: asked,
    routine: buildRoutine(assessment),
    disclaimer: COSMETIC_DISCLAIMER,
  };
}

function escalate(
  safety: { reason?: string; message?: string },
  asked: string[] = [],
): ConsultationResult {
  return {
    route: 'ESCALATE',
    confidence: 0,
    escalationReason: safety.reason,
    questionsAsked: asked,
    routine: [],
    disclaimer: safety.message ?? DERM_REFERRAL,
  };
}
