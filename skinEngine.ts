/**
 * Quality SkinCare — AI Skin Analyzer core engine (vision-agnostic).
 * ------------------------------------------------------------------
 * Self-contained. No dependencies, no API keys. Uses a MOCK vision provider
 * so the whole flow runs end-to-end today. Swap MockVisionProvider for a real
 * adapter later without touching anything downstream.
 *
 * Run:  npx tsx skinEngine.ts      (or: ts-node skinEngine.ts)
 *
 * Pipeline: assess → safety gate → confidence route → (questions → re-score)
 *           → weighted recommendation → explainability → routine
 */

// ============================================================================
// 1. TYPES
// ============================================================================

export type SkinType = 'dry' | 'oily' | 'combination' | 'normal' | 'sensitive';

export type ConcernKey =
  | 'acne' | 'acne_scars' | 'hyperpigmentation' | 'uneven_tone'
  | 'dark_spots' | 'fine_lines' | 'wrinkles' | 'enlarged_pores'
  | 'redness' | 'dry_patches' | 'excess_oil' | 'dehydration'
  | 'dullness' | 'sun_damage' | 'dark_circles';

export interface ConcernScore {
  key: ConcernKey;
  severity: number;    // 0..1  how pronounced
  confidence: number;  // 0..1  model certainty
}

export interface SkinAssessment {
  skinType: { value: SkinType; confidence: number };
  concerns: ConcernScore[];
  imageQualityScore: number;   // 0..1
  medicalFlags: string[];      // e.g. ['possible_infection']
  provider: string;
}

export type Slot = 'cleanser' | 'treatment' | 'moisturizer' | 'sunscreen';
export type TimeOfDay = 'am' | 'pm' | 'both';

export interface Product {
  sku: string;
  name: string;
  slot: Slot;
  time: TimeOfDay;
  medical: boolean;                                   // true → never auto-recommended
  addresses: Partial<Record<ConcernKey, number>>;     // weight 0..1 per concern
  suitsSkinType: SkinType[];
  cautions?: string[];
}

interface Driver { concern: ConcernKey; contrib: number; }
interface Scored { product: Product; score: number; drivers: Driver[]; }

export interface RoutineItem {
  sku: string;
  name: string;
  slot: Slot;
  when: TimeOfDay;
  score: number;
  timeline: string;
  explanation: string;
  cautions?: string[];
}

export interface ConsultationResult {
  route: 'RECOMMEND' | 'CLARIFY' | 'CONSULT' | 'ESCALATE';
  confidence: number;
  escalationReason?: string;
  questionsAsked: string[];
  routine: RoutineItem[];
  disclaimer: string;
}

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

// ============================================================================
// 2. PRODUCT CATALOG  (the IP — tune these weights against real captures)
// ============================================================================

export const CATALOG: Product[] = [
  { sku: 'QSC-BFW', name: 'Brightening Face Wash', slot: 'cleanser', time: 'both', medical: false,
    addresses: { dullness: 0.7, uneven_tone: 0.6, hyperpigmentation: 0.4, dark_spots: 0.4 },
    suitsSkinType: ['normal', 'dry', 'combination'] },

  { sku: 'QSC-SPF50', name: 'Sunblock SPF 50', slot: 'sunscreen', time: 'am', medical: false,
    addresses: { sun_damage: 0.9, hyperpigmentation: 0.6, dark_spots: 0.6, uneven_tone: 0.4, acne: 0.2 },
    suitsSkinType: ['dry', 'oily', 'combination', 'normal', 'sensitive'] },

  { sku: 'QSC-NC', name: 'Night Cream', slot: 'moisturizer', time: 'pm', medical: false,
    addresses: { dry_patches: 0.8, dehydration: 0.8, fine_lines: 0.6, wrinkles: 0.5 },
    suitsSkinType: ['dry', 'normal', 'combination', 'sensitive'] },

  { sku: 'QSC-BC', name: 'Brightening Cream', slot: 'treatment', time: 'pm', medical: false,
    addresses: { hyperpigmentation: 0.9, dark_spots: 0.85, uneven_tone: 0.8, dullness: 0.6 },
    suitsSkinType: ['normal', 'dry', 'combination', 'oily'],
    cautions: ['Introduce gradually — can irritate sensitive skin', 'Always pair with daily SPF'] },

  { sku: 'QSC-AAFW', name: 'Anti Acne Face Wash', slot: 'cleanser', time: 'both', medical: false,
    addresses: { acne: 0.85, excess_oil: 0.8, enlarged_pores: 0.5 },
    suitsSkinType: ['oily', 'combination'] },

  { sku: 'QSC-AAC', name: 'Anti Acne Cream', slot: 'treatment', time: 'pm', medical: false,
    addresses: { acne: 0.9, acne_scars: 0.3 },
    suitsSkinType: ['oily', 'combination', 'normal'],
    cautions: ['Spot-apply only', 'Do not combine with strong exfoliants the same night'] },

  { sku: 'QSC-AAS', name: 'Anti Acne Soap', slot: 'cleanser', time: 'both', medical: false,
    addresses: { acne: 0.7, excess_oil: 0.7 },
    suitsSkinType: ['oily', 'combination'] },

  { sku: 'QSC-BS', name: 'Brightening Soap', slot: 'cleanser', time: 'both', medical: false,
    addresses: { dullness: 0.6, uneven_tone: 0.5, hyperpigmentation: 0.4 },
    suitsSkinType: ['normal', 'oily', 'combination'] },

  // ── MEDICAL: hard-gated. Never scored, never auto-recommended. ──
  { sku: 'QSC-STS', name: 'Scabies Treatment Soap', slot: 'cleanser', time: 'both', medical: true,
    addresses: {}, suitsSkinType: [] },
  { sku: 'QSC-AFS', name: 'Anti Fungal Soap', slot: 'cleanser', time: 'both', medical: true,
    addresses: {}, suitsSkinType: [] },
];

// ============================================================================
// 3. CONFIDENCE ROUTER
// ============================================================================

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

// ============================================================================
// 4. QUESTION ENGINE
// ============================================================================

interface QOption {
  label: string;
  value: string;
  effects?: Partial<Record<ConcernKey, { dSeverity?: number; dConf?: number }>>;
  safetyScreen?: 'itch' | 'rash';   // routes to escalation, not a product
}
export interface Question {
  id: string;
  text: string;
  targets: ConcernKey[];
  options: QOption[];
}

export const QUESTION_BANK: Question[] = [
  { id: 'oil_return', text: 'Does your skin feel oily within ~2 hours of washing?',
    targets: ['excess_oil', 'acne'],
    options: [
      { label: 'Yes, shiny fast', value: 'yes', effects: { excess_oil: { dSeverity: +0.2, dConf: +0.15 } } },
      { label: 'Only T-zone', value: 'tzone', effects: { excess_oil: { dSeverity: +0.05, dConf: +0.1 } } },
      { label: 'No, feels tight', value: 'no',
        effects: { excess_oil: { dSeverity: -0.2, dConf: +0.15 }, dehydration: { dSeverity: +0.1, dConf: +0.05 } } },
    ] },

  { id: 'tight_after_cleanse', text: 'Does your skin feel tight or flaky after cleansing?',
    targets: ['dry_patches', 'dehydration'],
    options: [
      { label: 'Yes', value: 'yes',
        effects: { dry_patches: { dSeverity: +0.2, dConf: +0.15 }, dehydration: { dSeverity: +0.15, dConf: +0.1 } } },
      { label: 'No', value: 'no' },
    ] },

  { id: 'acne_painful', text: 'Are the breakouts painful, deep, or leaving marks?',
    targets: ['acne', 'acne_scars', 'hyperpigmentation'],
    options: [
      { label: 'Painful & deep', value: 'severe', effects: { acne: { dSeverity: +0.25, dConf: +0.2 } } },
      { label: 'Surface bumps', value: 'mild', effects: { acne: { dSeverity: +0.05, dConf: +0.15 } } },
      { label: 'Leaves dark marks', value: 'pih', effects: { hyperpigmentation: { dSeverity: +0.15, dConf: +0.1 } } },
    ] },

  { id: 'redness_reaction', text: 'Does your skin sting or go red when you try new products?',
    targets: ['redness'],
    options: [
      { label: 'Often', value: 'yes', effects: { redness: { dSeverity: +0.2, dConf: +0.2 } } },
      { label: 'Rarely', value: 'no' },
    ] },

  { id: 'dark_marks_duration', text: 'How long have your dark spots been there?',
    targets: ['hyperpigmentation', 'dark_spots'],
    options: [
      { label: 'Months / years', value: 'long',
        effects: { hyperpigmentation: { dSeverity: +0.15, dConf: +0.15 }, dark_spots: { dSeverity: +0.1, dConf: +0.1 } } },
      { label: 'Recent', value: 'recent', effects: { dark_spots: { dConf: +0.1 } } },
    ] },

  // Safety-screen questions — used ONLY in the full consult; route to escalation.
  { id: 'persistent_itch', text: 'Do you have a persistent itch that keeps coming back?',
    targets: [],
    options: [
      { label: 'Yes', value: 'yes', safetyScreen: 'itch' },
      { label: 'No', value: 'no' },
    ] },
  { id: 'spreading_rash', text: 'Is there a rash that is spreading or affecting others at home?',
    targets: [],
    options: [
      { label: 'Yes', value: 'yes', safetyScreen: 'rash' },
      { label: 'No', value: 'no' },
    ] },
];

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

// ============================================================================
// 5. SAFETY GATE  (runs before any product is shown)
// ============================================================================

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

const DERM_REFERRAL =
  "Some of what you've described is better assessed in person than by a skin scan. " +
  "We'd recommend seeing a dermatologist before starting any treatment. We're not showing " +
  "product suggestions here so we don't point you in the wrong direction.";

const COSMETIC_DISCLAIMER =
  'These suggestions are cosmetic and educational, not a medical diagnosis. ' +
  'If a concern is painful, spreading, or persistent, please consult a dermatologist.';

// ============================================================================
// 6. RECOMMENDATION ENGINE  (weighted scoring, not keyword matching)
// ============================================================================

export function scoreProducts(a: SkinAssessment): Scored[] {
  return CATALOG
    .filter(p => !p.medical)                              // SAFETY: medical never enters scoring
    .map(p => {
      const drivers: Driver[] = [];
      let raw = 0;
      for (const c of a.concerns) {
        const w = p.addresses[c.key];
        if (!w) continue;
        const contrib = w * c.severity * c.confidence;    // weight × severity × confidence
        if (contrib > 0.02) { raw += contrib; drivers.push({ concern: c.key, contrib }); }
      }
      const fit = p.suitsSkinType.length === 0 ? 1
        : p.suitsSkinType.includes(a.skinType.value) ? 1 : 0.55;
      return { product: p, score: raw * fit, drivers: drivers.sort((x, y) => y.contrib - x.contrib) };
    })
    .sort((x, y) => y.score - x.score);
}

const MINIMALISM_THRESHOLD = 0.08;   // below this, don't add a product (no upselling filler)
const REDUNDANCY_RATIO = 0.65;       // drop a product whose concerns are already covered

export function buildRoutine(a: SkinAssessment): RoutineItem[] {
  const scored = scoreProducts(a);
  const chosen = new Map<Slot, Scored>();

  for (const s of scored) {
    if (s.score < MINIMALISM_THRESHOLD) continue;
    const cur = chosen.get(s.product.slot);
    if (!cur || s.score > cur.score) chosen.set(s.product.slot, s);
  }

  // REDUNDANCY GUARD: if a product's top concern is already the top concern of a
  // higher-scoring product in the routine, it's an upsell, not a need. Drop it.
  // (Prevents e.g. Brightening Cream + Brightening Face Wash in the same routine.)
  const ranked = [...chosen.values()].sort((x, y) => y.score - x.score);
  const covered = new Set<ConcernKey>();
  for (const s of ranked) {
    const top = s.drivers[0]?.concern;
    if (!top) continue;
    if (covered.has(top) && s.product.slot !== 'sunscreen') {
      const leader = ranked.find(r => r.drivers[0]?.concern === top)!;
      if (s.score < leader.score * REDUNDANCY_RATIO) { chosen.delete(s.product.slot); continue; }
    }
    covered.add(top);
  }

  // SPF is a non-negotiable baseline if any pigmentation / sun / acne signal exists.
  if (!chosen.has('sunscreen')) {
    const spf = scored.find(s => s.product.slot === 'sunscreen');
    const needsSpf = a.concerns.some(c =>
      ['hyperpigmentation', 'dark_spots', 'sun_damage', 'acne'].includes(c.key) && c.severity > 0.2);
    if (spf && needsSpf) chosen.set('sunscreen', spf);
  }

  return [...chosen.values()]
    .sort((x, y) => y.score - x.score)
    .map(s => ({
      sku: s.product.sku,
      name: s.product.name,
      slot: s.product.slot,
      when: s.product.time,
      score: Number(s.score.toFixed(3)),
      timeline: timelineFor(s),
      explanation: explain(s, a),
      cautions: s.product.cautions,
    }));
}

// ============================================================================
// 7. EXPLAINABILITY  +  RESULT TIMELINES
// ============================================================================

const CONCERN_PHRASE: Record<ConcernKey, string> = {
  excess_oil: 'excess oil', acne: 'active breakouts', hyperpigmentation: 'uneven dark patches',
  dark_spots: 'dark spots', dullness: 'dullness', dehydration: 'dehydration',
  dry_patches: 'dry, tight areas', fine_lines: 'early fine lines', wrinkles: 'lines',
  sun_damage: 'sun exposure', uneven_tone: 'uneven tone', redness: 'redness',
  enlarged_pores: 'visible pores', acne_scars: 'acne marks', dark_circles: 'dark circles',
};

export function explain(s: Scored, a: SkinAssessment): string {
  const top = s.drivers.slice(0, 2).map(d => CONCERN_PHRASE[d.concern]);
  const conf = a.concerns.find(c => c.key === s.drivers[0]?.concern)?.confidence ?? 0.8;
  const certainty = conf >= 0.9 ? 'clearly' : conf >= 0.75 ? 'likely' : 'possibly';
  const when = s.product.time === 'am' ? 'in the morning'
    : s.product.time === 'pm' ? 'at night' : 'morning and night';
  const caution = s.product.cautions?.length ? ` Note: ${s.product.cautions[0]}.` : '';
  return `We ${certainty} noticed ${top.join(' and ')}. ${s.product.name} targets this — `
    + `best used ${when}.${caution}`;
}

function timelineFor(s: Scored): string {
  if (s.product.slot === 'sunscreen') return 'Protective — use daily, ongoing';
  if (s.product.slot === 'moisturizer') return 'Comfort in ~1–2 weeks';
  // Look across ALL drivers, not just the top one — an acne cleanser whose top
  // driver is excess_oil is still an acne product and should quote acne timing.
  const keys = s.drivers.map(d => d.concern);
  if (keys.includes('acne')) return 'Visible change in ~4–6 weeks';
  if (keys.some(k => ['hyperpigmentation', 'dark_spots', 'uneven_tone'].includes(k)))
    return 'Visible change in ~6–8 weeks';
  return 'Visible change in ~4 weeks';
}

// ============================================================================
// 8. MOCK VISION PROVIDER  (swap for a real adapter later)
// ============================================================================

export interface SkinVisionProvider {
  analyze(frames: unknown): Promise<SkinAssessment>;
}

export class MockVisionProvider implements SkinVisionProvider {
  constructor(private preset: SkinAssessment) {}
  async analyze(_frames: unknown): Promise<SkinAssessment> {
    return JSON.parse(JSON.stringify(this.preset));   // deep copy, like a real network return
  }
}

// ============================================================================
// 9. ORCHESTRATOR
// ============================================================================

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

// ============================================================================
// 10. DEMO  (run this file directly to see it work)
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