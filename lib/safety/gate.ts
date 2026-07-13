import type { SkinAssessment } from '../vision/types';
import { QUESTION_BANK } from '../questions/bank';

/** SAFETY GATE — runs before any product is shown. */
export function safetyCheck(
  a: SkinAssessment,
  answers: Record<string, string>,
): { escalate: boolean; reason?: string; message?: string } {

  const flag = a.medicalFlags.find(f =>
    ['possible_infection', 'suspicious_lesion', 'open_wound', 'burn', 'severe_inflammation'].includes(f));
  if (flag) return { escalate: true, reason: `MEDICAL_FLAG:${flag}`, message: DERM_REFERRAL };

  const acne = a.concerns.find(c => c.key === 'acne');
  if (acne && acne.severity > 0.8 && answers['acne_painful'] === 'severe')
    return { escalate: true, reason: 'SEVERE_ACNE', message: DERM_REFERRAL };

  // The ONLY path that can touch fungal/parasitic territory — ends in referral,
  // never in a product recommendation for the two medical soaps.
  for (const q of QUESTION_BANK) {
    const opt = q.options.find(o => o.value === answers[q.id]);
    if (opt?.safetyScreen)
      return { escalate: true, reason: `REFER_${opt.safetyScreen.toUpperCase()}`, message: DERM_REFERRAL };
  }

  return { escalate: false };
}

export const DERM_REFERRAL =
  "Some of what you've described is better assessed in person than by a skin scan. " +
  "We'd recommend seeing a dermatologist before starting any treatment. We're not showing " +
  "product suggestions here so we don't point you in the wrong direction.";

export const COSMETIC_DISCLAIMER =
  'These suggestions are cosmetic and educational, not a medical diagnosis. ' +
  'If a concern is painful, spreading, or persistent, please consult a dermatologist.';
