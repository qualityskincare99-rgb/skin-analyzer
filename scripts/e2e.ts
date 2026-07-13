/**
 * End-to-end consultation walk through the real HTTP API (spec §10), mock
 * vision provider, in-memory repo — testing ladder stage 1 (spec §14).
 *
 * Boots `next dev` on a throwaway port, then drives the five engine demo
 * scenarios (skinEngine.ts) and asserts exact parity with the engine's
 * output: routes, confidences, SKUs, scores, escalation reasons. Also covers
 * the API-level guards: auth, consent-before-analyze, answer validation, and
 * the CORS allowlist.
 *
 * Run: npm run test:e2e
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SkinAssessment } from '../lib/vision/types';

const PORT = 4319;
const API = `http://127.0.0.1:${PORT}/api/skin`;
const ALLOWED_ORIGIN = 'https://quality-skincare.myshopify.com';
const EVIL_ORIGIN = 'https://evil.example';

// ── Presets: verbatim from the skinEngine.ts demo ───────────────────────────

const PRESET_A: SkinAssessment = {
  provider: 'mock', imageQualityScore: 0.95, medicalFlags: [],
  skinType: { value: 'oily', confidence: 0.93 },
  concerns: [
    { key: 'acne', severity: 0.6, confidence: 0.92 },
    { key: 'excess_oil', severity: 0.7, confidence: 0.94 },
    { key: 'enlarged_pores', severity: 0.4, confidence: 0.9 },
    { key: 'hyperpigmentation', severity: 0.3, confidence: 0.88 },
  ],
};

const PRESET_B: SkinAssessment = {
  provider: 'mock', imageQualityScore: 0.8, medicalFlags: [],
  skinType: { value: 'dry', confidence: 0.72 },
  concerns: [
    { key: 'hyperpigmentation', severity: 0.55, confidence: 0.74 },
    { key: 'dark_spots', severity: 0.5, confidence: 0.7 },
    { key: 'dry_patches', severity: 0.45, confidence: 0.76 },
    { key: 'dullness', severity: 0.4, confidence: 0.8 },
  ],
};

const PRESET_C: SkinAssessment = {
  provider: 'mock', imageQualityScore: 0.6, medicalFlags: [],
  skinType: { value: 'combination', confidence: 0.6 },
  concerns: [{ key: 'acne', severity: 0.9, confidence: 0.65 }],
};

const PRESET_D: SkinAssessment = {
  provider: 'mock', imageQualityScore: 0.5, medicalFlags: [],
  skinType: { value: 'sensitive', confidence: 0.5 },
  concerns: [{ key: 'redness', severity: 0.4, confidence: 0.5 }],
};

const PRESET_E: SkinAssessment = {
  provider: 'mock', imageQualityScore: 0.9, medicalFlags: ['possible_infection'],
  skinType: { value: 'normal', confidence: 0.9 },
  concerns: [{ key: 'acne', severity: 0.5, confidence: 0.9 }],
};

// ── Tiny test harness ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    { expected, actual });
}

interface ApiResponse { status: number; headers: Headers; json: any }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; origin?: string } = {},
): Promise<ApiResponse> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* 204s etc. */ }
  return { status: res.status, headers: res.headers, json: body };
}

async function newSession(): Promise<{ sessionId: string; token: string }> {
  const r = await api('POST', '/session');
  if (r.status !== 201) throw new Error(`POST /session failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function startConsult(preset: SkinAssessment): Promise<{ token: string; analyze: ApiResponse }> {
  const { token } = await newSession();
  const consent = await api('POST', '/consent', { token, body: { scope: ['image_analysis', 'store_results'] } });
  if (consent.status !== 201) throw new Error(`POST /consent failed: ${consent.status}`);
  const analyze = await api('POST', '/analyze', { token, body: { mockAssessment: preset } });
  return { token, analyze };
}

const skus = (routine: any[]) => routine.map(r => r.sku);
const scores = (routine: any[]) => routine.map(r => r.score);
const allRoutines: any[][] = [];

// ── Scenarios ────────────────────────────────────────────────────────────────

async function scenarioA(): Promise<void> {
  console.log('\nScenario A · oily + acne, high confidence → straight RECOMMEND');
  const { token, analyze } = await startConsult(PRESET_A);
  eq('analyze → state RECOMMEND', analyze.json.state, 'RECOMMEND');
  eq('analyze → confidence 0.916', analyze.json.confidence, 0.916);
  eq('analyze → no questions', analyze.json.questions, []);

  const rec = await api('POST', '/recommend', { token });
  eq('recommend → 200', rec.status, 200);
  eq('recommend → route RECOMMEND', rec.json.route, 'RECOMMEND');
  eq('recommend → confidence 0.916', rec.json.confidence, 0.916);
  eq('recommend → questionsAsked empty', rec.json.questionsAsked, []);
  eq('routine SKUs match engine demo', skus(rec.json.routine), ['QSC-AAFW', 'QSC-AAC', 'QSC-SPF50']);
  eq('routine scores match engine demo', scores(rec.json.routine), [1.176, 0.497, 0.269]);
  check('cosmetic disclaimer present', String(rec.json.disclaimer).startsWith('These suggestions are cosmetic'));
  allRoutines.push(rec.json.routine);

  const again = await api('POST', '/recommend', { token });
  eq('second recommend → 409', again.status, 409);
}

async function scenarioB(): Promise<void> {
  console.log('\nScenario B · pigmentation + dryness → CLARIFY, answer, RECOMMEND');
  const { token, analyze } = await startConsult(PRESET_B);
  eq('analyze → state CLARIFY', analyze.json.state, 'CLARIFY');
  eq('analyze → 3 questions in selection order',
    analyze.json.questions.map((q: any) => q.id),
    ['dark_marks_duration', 'acne_painful', 'tight_after_cleanse']);
  check('questions carry no scoring internals',
    analyze.json.questions.every((q: any) =>
      !('effects' in q) && !('targets' in q)
      && q.options.every((o: any) => !('effects' in o) && !('safetyScreen' in o))));

  const questions = await api('GET', '/questions', { token });
  eq('GET /questions matches analyze payload',
    questions.json.questions.map((q: any) => q.id),
    analyze.json.questions.map((q: any) => q.id));

  const answer = await api('POST', '/answer', {
    token,
    body: { answers: { dark_marks_duration: 'long', tight_after_cleanse: 'yes' } },
  });
  eq('answer → state RECOMMEND', answer.json.state, 'RECOMMEND');
  eq('answer → re-scored confidence 0.835', answer.json.confidence, 0.835);

  const rec = await api('POST', '/recommend', { token });
  eq('recommend → confidence 0.835', rec.json.confidence, 0.835);
  eq('routine SKUs match engine demo', skus(rec.json.routine), ['QSC-BC', 'QSC-SPF50', 'QSC-NC']);
  eq('routine scores match engine demo', scores(rec.json.routine), [1.161, 0.662, 0.545]);
  eq('questionsAsked matches engine demo', rec.json.questionsAsked,
    ['dark_marks_duration', 'acne_painful', 'tight_after_cleanse']);
  check('no cleanser slot (redundancy guard, the open business question)',
    rec.json.routine.every((r: any) => r.slot !== 'cleanser'));
  allRoutines.push(rec.json.routine);
}

async function scenarioC(): Promise<void> {
  console.log('\nScenario C · severe acne, painful → ESCALATE from triage');
  const { token, analyze } = await startConsult(PRESET_C);
  eq('analyze → state TRIAGE', analyze.json.state, 'TRIAGE');
  eq('triage asks the pain question first', analyze.json.questions.map((q: any) => q.id), ['acne_painful']);

  const answer = await api('POST', '/answer', { token, body: { answers: { acne_painful: 'severe' } } });
  eq('answer → route ESCALATE', answer.json.route, 'ESCALATE');
  eq('escalation reason SEVERE_ACNE', answer.json.escalationReason, 'SEVERE_ACNE');
  eq('confidence zeroed', answer.json.confidence, 0);
  eq('zero products', answer.json.routine, []);
  eq('questionsAsked matches engine demo', answer.json.questionsAsked, ['acne_painful']);
  check('derm referral message', String(answer.json.disclaimer).includes('dermatologist'));
  allRoutines.push(answer.json.routine);

  const rec = await api('POST', '/recommend', { token });
  eq('recommend after escalation → 409', rec.status, 409);
  check('409 body mentions referral, still zero products',
    String(rec.json.error).includes('referral') && rec.json.routine === undefined);
}

async function scenarioD(): Promise<void> {
  console.log('\nScenario D · persistent itch → derm referral (medical-soap adjacency)');
  const { token, analyze } = await startConsult(PRESET_D);
  eq('analyze → state TRIAGE', analyze.json.state, 'TRIAGE');
  eq('triage runs both safety screens', analyze.json.questions.map((q: any) => q.id),
    ['persistent_itch', 'spreading_rash']);

  const answer = await api('POST', '/answer', { token, body: { answers: { persistent_itch: 'yes' } } });
  eq('answer → route ESCALATE', answer.json.route, 'ESCALATE');
  eq('escalation reason REFER_ITCH', answer.json.escalationReason, 'REFER_ITCH');
  eq('zero products', answer.json.routine, []);
  eq('questionsAsked matches engine demo', answer.json.questionsAsked, ['persistent_itch', 'spreading_rash']);
  allRoutines.push(answer.json.routine);

  const questions = await api('GET', '/questions', { token });
  eq('escalated session has no pending questions', questions.json, { state: 'ESCALATE', questions: [] });
}

async function scenarioE(): Promise<void> {
  console.log('\nScenario E · medical flag on image → immediate ESCALATE');
  const { analyze } = await startConsult(PRESET_E);
  eq('analyze → route ESCALATE', analyze.json.route, 'ESCALATE');
  eq('escalation reason from image flag', analyze.json.escalationReason, 'MEDICAL_FLAG:possible_infection');
  eq('no questions ever asked', analyze.json.questionsAsked, []);
  eq('zero products', analyze.json.routine, []);
  allRoutines.push(analyze.json.routine);
}

async function guards(): Promise<void> {
  console.log('\nGuards · auth, consent, validation, CORS');

  const noToken = await api('POST', '/analyze', { body: { mockAssessment: PRESET_A } });
  eq('analyze without token → 401', noToken.status, 401);

  const { token } = await newSession();
  const noConsent = await api('POST', '/analyze', { token, body: { mockAssessment: PRESET_A } });
  eq('analyze without consent → 403', noConsent.status, 403);

  const badAssessment = await api('POST', '/consent', { token, body: { scope: ['image_analysis'] } })
    .then(() => api('POST', '/analyze', { token, body: { mockAssessment: { nonsense: true } } }));
  eq('malformed mockAssessment → 400', badAssessment.status, 400);

  const b = await startConsult(PRESET_B);
  const rogue = await api('POST', '/answer', { token: b.token, body: { answers: { oil_return: 'no' } } });
  eq('answer to non-pending question → 400', rogue.status, 400);
  const badValue = await api('POST', '/answer', { token: b.token, body: { answers: { acne_painful: 'nonsense' } } });
  eq('answer with unknown option value → 400', badValue.status, 400);

  const preflightOk = await api('OPTIONS', '/session', { origin: ALLOWED_ORIGIN });
  eq('preflight from storefront → 204', preflightOk.status, 204);
  eq('preflight echoes allowlisted origin',
    preflightOk.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

  const preflightEvil = await api('OPTIONS', '/session', { origin: EVIL_ORIGIN });
  check('preflight from foreign origin gets no CORS grant',
    preflightEvil.headers.get('access-control-allow-origin') === null);

  const postOk = await api('POST', '/session', { origin: ALLOWED_ORIGIN });
  eq('actual response also carries the CORS grant',
    postOk.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Booting next dev on :${PORT} (in-memory repo, mock provider)…`);
  const server = spawn('node_modules/.bin/next', ['dev', '-p', String(PORT)], {
    env: {
      ...process.env,
      SESSION_JWT_SECRET: 'e2e-only-secret-do-not-use-anywhere-else',
      SHOPIFY_STOREFRONT_ORIGIN: ALLOWED_ORIGIN,
      // Force testing-ladder stage 1 even if the shell has real Supabase vars.
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      VISION_PROVIDER: 'mock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout!.on('data', d => { serverLog += d; });
  server.stderr!.on('data', d => { serverLog += d; });

  try {
    let ready = false;
    for (let i = 0; i < 240; i++) {
      try {
        const r = await fetch(`${API}/session`, { method: 'OPTIONS' });
        if (r.status === 204) { ready = true; break; }
      } catch { /* not up yet */ }
      await sleep(500);
    }
    if (!ready) throw new Error(`server never became ready.\n--- server log ---\n${serverLog}`);
    console.log('Server ready.');

    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
    await guards();

    console.log('\nInvariant · hard-gated medical SKUs');
    check('QSC-STS / QSC-AFS never appear in any routine',
      allRoutines.flat().every((r: any) => r.sku !== 'QSC-STS' && r.sku !== 'QSC-AFS'));
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
