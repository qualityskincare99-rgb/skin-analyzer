import type { ConcernKey, SkinAssessment } from '../vision/types';
import { QUESTION_BANK, type Question } from './bank';

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

/** Pick the N questions whose targets have the highest (severity × uncertainty). */
export function selectQuestions(a: SkinAssessment, n: number): Question[] {
  const uncertainty = new Map<ConcernKey, number>();
  a.concerns.forEach(c => uncertainty.set(c.key, c.severity * (1 - c.confidence)));

  return QUESTION_BANK
    .filter(q => q.targets.length > 0)                      // effect questions only
    .map(q => ({ q, s: q.targets.reduce((sum, t) => sum + (uncertainty.get(t) ?? 0), 0) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, n)
    .map(x => x.q);
}

/** Apply answers back onto the assessment (mutates a copy). */
export function applyAnswers(
  a: SkinAssessment,
  answers: Record<string, string>,
): SkinAssessment {
  const next: SkinAssessment = { ...a, concerns: a.concerns.map(c => ({ ...c })) };
  const byKey = new Map(next.concerns.map(c => [c.key, c]));

  for (const q of QUESTION_BANK) {
    const val = answers[q.id];
    if (!val) continue;
    const opt = q.options.find(o => o.value === val);
    if (!opt?.effects) continue;

    for (const [k, eff] of Object.entries(opt.effects) as [ConcernKey, { dSeverity?: number; dConf?: number }][]) {
      let c = byKey.get(k);
      if (!c) { c = { key: k, severity: 0, confidence: 0.5 }; next.concerns.push(c); byKey.set(k, c); }
      c.severity = clamp(c.severity + (eff.dSeverity ?? 0));
      c.confidence = clamp(c.confidence + (eff.dConf ?? 0));
    }
  }
  return next;
}
