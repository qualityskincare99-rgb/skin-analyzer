import type { SkinAssessment } from '../vision/types';

export type Route = 'RECOMMEND' | 'CLARIFY' | 'CONSULT';

export function routeByConfidence(a: SkinAssessment): { route: Route; confidence: number } {
  const weighted = a.concerns.map(c => ({ w: c.severity + 0.1, c: c.confidence }));
  const num = weighted.reduce((s, x) => s + x.w * x.c, 0);
  const den = weighted.reduce((s, x) => s + x.w, 0) || 1;
  const avg = num / den;

  // Poor image quality caps confidence no matter how sure the model claims to be.
  const capped = Math.min(avg, 0.6 + 0.4 * a.imageQualityScore);

  if (capped >= 0.90) return { route: 'RECOMMEND', confidence: capped };
  if (capped >= 0.70) return { route: 'CLARIFY', confidence: capped };
  return { route: 'CONSULT', confidence: capped };
}
