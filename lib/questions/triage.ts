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

  // Fungal/parasitic screen. Asked on EVERY consultation, unconditionally.
  //
  // This is the only path to the dermatologist referral for scabies/fungal
  // presentation, and it must not depend on a vision signal. Gating it on
  // detected redness meant a user whose assessment returned no redness was
  // never asked and went straight to products — and redness detection is
  // least reliable on exactly the Fitzpatrick IV-VI skin this serves.
  // Two extra questions on every consult is the price of that guarantee.
  qs.push(...QUESTION_BANK.filter(q => q.targets.length === 0));

  return qs;
}
