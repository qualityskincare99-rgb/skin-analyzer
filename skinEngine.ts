/**
 * Quality SkinCare — AI Skin Analyzer core engine (vision-agnostic).
 * ------------------------------------------------------------------
 * The engine lives in /lib (module layout per CLAUDE.md). This file is the
 * runnable demo plus a re-export of the public API, so existing imports and
 * `npx tsx skinEngine.ts` keep working unchanged.
 *
 * Run:  npx tsx skinEngine.ts      (or: ts-node skinEngine.ts)
 *
 * Pipeline: assess → safety gate → confidence route → (questions → re-score)
 *           → weighted recommendation → explainability → routine
 */

export * from './lib/vision/types';
export * from './lib/vision/provider';
export * from './lib/vision/mock';
export * from './lib/confidence/router';
export * from './lib/questions/bank';
export * from './lib/questions/triage';
export * from './lib/questions/select';
export * from './lib/safety/gate';
export * from './lib/reco/catalog';
export * from './lib/reco/engine';
export * from './lib/reco/explain';
export * from './lib/reco/timelines';
export * from './lib/orchestrator';

import { MockVisionProvider } from './lib/vision/mock';
import { runConsultation, type ConsultationResult } from './lib/orchestrator';

// ============================================================================
// DEMO  (run this file directly to see it work)
// ============================================================================

function print(title: string, r: ConsultationResult) {
  console.log(`\n━━━ ${title} ━━━`);
  console.log(`route: ${r.route}   confidence: ${r.confidence}`);
  if (r.questionsAsked.length) console.log(`asked: ${r.questionsAsked.join(', ')}`);
  if (r.route === 'ESCALATE') { console.log(`⚠️  ${r.escalationReason}\n   ${r.disclaimer}`); return; }
  if (!r.routine.length) { console.log('No routine met the recommendation threshold.'); return; }
  for (const item of r.routine) {
    console.log(`  • [${item.slot}/${item.when}] ${item.name}  (score ${item.score})`);
    console.log(`      ${item.explanation}`);
    console.log(`      timeline: ${item.timeline}`);
  }
  console.log(`  ${r.disclaimer}`);
}

async function demo() {
  // A: high-confidence oily + acne, good image → straight to RECOMMEND
  const A = new MockVisionProvider({
    provider: 'mock', imageQualityScore: 0.95, medicalFlags: [],
    skinType: { value: 'oily', confidence: 0.93 },
    concerns: [
      { key: 'acne', severity: 0.6, confidence: 0.92 },
      { key: 'excess_oil', severity: 0.7, confidence: 0.94 },
      { key: 'enlarged_pores', severity: 0.4, confidence: 0.9 },
      { key: 'hyperpigmentation', severity: 0.3, confidence: 0.88 }, // triggers SPF baseline
    ],
  });
  print('A · oily + acne, high confidence', await runConsultation(A));

  // B: mid-confidence pigmentation on dry skin → CLARIFY, user answers
  const B = new MockVisionProvider({
    provider: 'mock', imageQualityScore: 0.8, medicalFlags: [],
    skinType: { value: 'dry', confidence: 0.72 },
    concerns: [
      { key: 'hyperpigmentation', severity: 0.55, confidence: 0.74 },
      { key: 'dark_spots', severity: 0.5, confidence: 0.7 },
      { key: 'dry_patches', severity: 0.45, confidence: 0.76 },
      { key: 'dullness', severity: 0.4, confidence: 0.8 },
    ],
  });
  print('B · pigmentation + dryness, needs clarify', await runConsultation(B, (qs) => {
    const ans: Record<string, string> = {};
    for (const q of qs) {
      if (q.id === 'dark_marks_duration') ans[q.id] = 'long';
      if (q.id === 'tight_after_cleanse') ans[q.id] = 'yes';
      if (q.id === 'oil_return') ans[q.id] = 'no';
    }
    return ans;
  }));

  // C: severe acne + painful answer → ESCALATE (no products)
  const C = new MockVisionProvider({
    provider: 'mock', imageQualityScore: 0.6, medicalFlags: [],
    skinType: { value: 'combination', confidence: 0.6 },
    concerns: [{ key: 'acne', severity: 0.9, confidence: 0.65 }],
  });
  print('C · severe acne, painful → escalate', await runConsultation(C, () => ({ acne_painful: 'severe' })));

  // D: itch/rash safety screen → ESCALATE to derm (the ONLY route near the medical soaps)
  const D = new MockVisionProvider({
    provider: 'mock', imageQualityScore: 0.5, medicalFlags: [],
    skinType: { value: 'sensitive', confidence: 0.5 },
    concerns: [{ key: 'redness', severity: 0.4, confidence: 0.5 }],
  });
  print('D · persistent itch → derm referral', await runConsultation(D, () => ({ persistent_itch: 'yes' })));

  // E: image flag → immediate ESCALATE before any questions
  const E = new MockVisionProvider({
    provider: 'mock', imageQualityScore: 0.9, medicalFlags: ['possible_infection'],
    skinType: { value: 'normal', confidence: 0.9 },
    concerns: [{ key: 'acne', severity: 0.5, confidence: 0.9 }],
  });
  print('E · medical flag on image → escalate', await runConsultation(E));
}

// Auto-run when executed directly (tsx / ts-node). Safe to remove for import use.
demo().catch(console.error);
