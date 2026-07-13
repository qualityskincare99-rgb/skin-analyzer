import type { SkinAssessment } from '../vision/types';
import { QUESTION_BANK, type Question } from './bank';

/**
 * Triage questions: asked FIRST, before the main consult, so a user who needs a
 * dermatologist is escalated in 1-2 questions instead of sitting through all 7.
 * Only asked when the assessment gives us a reason to — never routinely.
 */
export function triageQuestions(a: SkinAssessment): Question[] {
  const qs: Question[] = [];
  const acne = a.concerns.find(c => c.key === 'acne');

  // Severe acne signal → ask the pain question up front.
  if (acne && acne.severity > 0.8)
    qs.push(QUESTION_BANK.find(q => q.id === 'acne_painful')!);

  // Redness/irritation with no clear cosmetic explanation → screen for
  // fungal/parasitic. NOT asked of everyone; only when the image hints at it.
  const redness = a.concerns.find(c => c.key === 'redness');
  if (redness && redness.severity > 0.3)
    qs.push(...QUESTION_BANK.filter(q => q.targets.length === 0));

  return qs;
}
