/**
 * Calibration harness — the instrument for CLAUDE.md's "one thing to get
 * right": tuning the weight matrix against real Fitzpatrick IV-VI captures
 * rather than defaults.
 *
 * It walks a folder of captures, pushes each subject through the real HTTP
 * path (session -> consent -> analyze), reads back the raw assessment the
 * provider produced, and prints what the model claims to see. Given labels it
 * also answers the question the whole project turns on: how often does the
 * provider invent a concern on skin where none exists?
 *
 * Three things it does deliberately:
 *
 *   It reproduces the capture pipeline exactly. The UI centre-crops the video
 *   to a square and encodes JPEG at quality 0.9 (public/analyzer/index.html,
 *   the #shutter handler). A 12-megapixel phone PNG fed straight to a vendor
 *   would score better than anything a customer's webcam will ever produce,
 *   and would calibrate the weights against a fiction.
 *
 *   It reads the assessment from the `analyses` row, not from /recommend.
 *   /recommend returns concerns after question answers have adjusted them;
 *   the row is what the provider actually said, which is what is being
 *   calibrated.
 *
 *   It shouts when every assessment comes back identical. With
 *   VISION_PROVIDER=mock the API serves a fixed DEMO_PRESET and ignores the
 *   frames entirely, so a run produces a beautiful table of meaningless
 *   numbers. That failure has to be impossible to miss.
 *
 * Usage:
 *   npm run calibrate -- --init-labels --dir ./captures   # scaffold labels
 *   npm run calibrate -- --dir ./captures                 # run
 *   npm run calibrate -- --dir ./captures --csv out.csv
 *   npm run calibrate -- --dir ./captures --base https://<deployment>/api/skin
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Jimp } from 'jimp';
import { createRepo } from '../lib/db/repo';
import type { ConcernKey, ConcernScore, SkinType } from '../lib/vision/types';

try { process.loadEnvFile('.env.local'); } catch { /* fall back to shell env */ }

const CONCERN_KEYS: ConcernKey[] = [
  'acne', 'acne_scars', 'hyperpigmentation', 'uneven_tone',
  'dark_spots', 'fine_lines', 'wrinkles', 'enlarged_pores',
  'redness', 'dry_patches', 'excess_oil', 'dehydration',
  'dullness', 'sun_damage', 'dark_circles',
];

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const FRAME_KEYS = ['front', 'left', 'right'] as const;
type FrameKey = typeof FRAME_KEYS[number];

/** A concern predicted above this is treated as "the model says it is there". */
const PRESENT_THRESHOLD = 0.25;

// ── Labels ───────────────────────────────────────────────────────────────────

interface SubjectLabel {
  id: string;
  frames: Partial<Record<FrameKey, string>>;
  /** Fitzpatrick I-VI. The breakdown this project exists to check. */
  fitzpatrick?: number | null;
  skinType?: SkinType | null;
  /** Concerns you can see, with your own 0..1 severity. */
  present?: Partial<Record<ConcernKey, number>>;
  /** Concerns you are confident are NOT there. This is what catches a model
   *  reading melanin as damage, and it is the cheapest field to fill. */
  absent?: ConcernKey[];
  /** Shorthand: nothing visible at all. Everything not in `present` counts as absent. */
  clear?: boolean;
  notes?: string;
}

interface LabelFile {
  subjects: SubjectLabel[];
}

// ── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  dir: string;
  labels?: string;
  initLabels: boolean;
  base: string;
  csv?: string;
  maxEdge: number;
  keep: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const val = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const dir = val('--dir');
  if (!dir) {
    console.error(
      'Usage: npm run calibrate -- --dir <folder of captures> [--labels f.json]\n' +
      '                           [--init-labels] [--base url] [--csv out.csv]\n' +
      '                           [--max-edge 1080] [--keep]',
    );
    process.exit(1);
  }
  return {
    dir: resolve(dir),
    labels: val('--labels'),
    initLabels: a.includes('--init-labels'),
    base: val('--base') ?? 'http://127.0.0.1:3000/api/skin',
    csv: val('--csv'),
    maxEdge: Number(val('--max-edge') ?? 1080),
    keep: a.includes('--keep'),
  };
}

// ── Subject discovery ────────────────────────────────────────────────────────

/**
 * Group the folder into subjects. `name-front.jpg` / `name-left.jpg` /
 * `name-right.jpg` become one three-frame subject; anything else is a subject
 * of its own with a single front frame. A labels file overrides all of this.
 */
function discoverSubjects(dir: string): SubjectLabel[] {
  const files = readdirSync(dir)
    .filter(f => IMAGE_EXT.has(extname(f).toLowerCase()))
    .sort();

  const grouped = new Map<string, SubjectLabel>();
  for (const file of files) {
    const stem = basename(file, extname(file));
    const m = /^(.*)[-_](front|left|right)$/i.exec(stem);
    const id = m ? m[1] : stem;
    const key = (m ? m[2].toLowerCase() : 'front') as FrameKey;
    const subject = grouped.get(id) ?? { id, frames: {} };
    subject.frames[key] = file;
    grouped.set(id, subject);
  }
  return [...grouped.values()];
}

function writeLabelTemplate(dir: string, path: string): void {
  const subjects = discoverSubjects(dir).map(s => ({
    ...s,
    fitzpatrick: null,
    skinType: null,
    present: {},
    absent: [],
    clear: false,
    notes: '',
  }));

  const doc = {
    _README: [
      'Ground truth for the calibration harness. One entry per subject.',
      '',
      'fitzpatrick : 1-6. The single most important field. Without it there is no',
      '              per-tone breakdown, and the per-tone breakdown is the point.',
      'absent      : concerns you are confident are NOT present. Every one of these',
      '              the model scores above ' + PRESENT_THRESHOLD + ' is a false positive. Fill this',
      '              before you fill `present` — it is cheaper and it is what catches',
      '              a model reading normal melanin as sun damage.',
      'clear       : true if the face shows nothing at all. Equivalent to listing',
      '              every concern in `absent`, minus anything in `present`.',
      'present     : concern -> your own 0..1 severity, for the concerns you do see.',
      'skinType    : dry | oily | combination | normal | sensitive',
      '',
      'Partial labels are fine. Anything left blank is simply not scored.',
    ],
    _concernKeys: CONCERN_KEYS,
    subjects,
  };

  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

// ── Capture encoding: mirror the UI exactly ──────────────────────────────────

async function encodeFrame(path: string, maxEdge: number): Promise<string> {
  const img = await Jimp.read(path);
  const { width, height } = img.bitmap;
  const side = Math.min(width, height);

  // Same centre-crop the #shutter handler applies to the video element.
  img.crop({
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    w: side,
    h: side,
  });

  // A webcam frame is around 720-1080 square. Downscale anything larger so the
  // provider sees production-grade input; never upscale a small photo into
  // detail it does not have.
  if (side > maxEdge) img.resize({ w: maxEdge, h: maxEdge });

  const buf = await img.getBuffer('image/jpeg', { quality: 90 });
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// ── API ──────────────────────────────────────────────────────────────────────

interface Observed {
  sessionId: string;
  provider: string;
  imageQuality: number | null;
  concerns: ConcernScore[];
  medicalFlags: string[];
  skinType: string | null;
  skinTypeConf: number | null;
  escalated: boolean;
  bytes: number;
  error?: string;
}

async function post(base: string, path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

async function runSubject(
  args: Args,
  db: SupabaseClient,
  subject: SubjectLabel,
): Promise<Observed> {
  const frames: Record<string, string> = {};
  let bytes = 0;
  for (const [key, file] of Object.entries(subject.frames)) {
    if (!file) continue;
    const url = await encodeFrame(join(args.dir, file), args.maxEdge);
    frames[key] = url;
    bytes += url.length;
  }

  const blank: Observed = {
    sessionId: '', provider: '', imageQuality: null, concerns: [],
    medicalFlags: [], skinType: null, skinTypeConf: null,
    escalated: false, bytes,
  };

  const session = await post(args.base, '/session', {});
  if (session.status !== 201)
    return { ...blank, error: `session ${session.status}: ${JSON.stringify(session.json)}` };
  const { sessionId, token } = session.json;

  const consent = await post(args.base, '/consent', { scope: ['image_analysis', 'store_results'] }, token);
  if (consent.status !== 201)
    return { ...blank, sessionId, error: `consent ${consent.status}` };

  const analyze = await post(args.base, '/analyze', { frames }, token);
  if (analyze.status !== 200)
    return { ...blank, sessionId, error: `analyze ${analyze.status}: ${JSON.stringify(analyze.json)}` };

  // The raw assessment, straight from the row. /analyze's response is the
  // state machine's next step, not what the provider saw.
  const { data, error } = await db
    .from('analyses')
    .select('provider, image_quality, concerns, medical_flags')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return { ...blank, sessionId, error: `read analysis: ${error?.message ?? 'no row'}` };

  const { data: srow } = await db
    .from('sessions').select('skin_type, skin_type_conf').eq('id', sessionId).maybeSingle();

  const row = data as { provider: string; image_quality: number | null; concerns: ConcernScore[]; medical_flags: string[] };
  return {
    sessionId,
    provider: row.provider,
    imageQuality: row.image_quality,
    concerns: row.concerns ?? [],
    medicalFlags: row.medical_flags ?? [],
    skinType: (srow as any)?.skin_type ?? null,
    skinTypeConf: (srow as any)?.skin_type_conf ?? null,
    escalated: analyze.json?.route === 'ESCALATE',
    bytes,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
const padL = (s: string, w: number) => s.length >= w ? s : ' '.repeat(w - s.length) + s;

function severityOf(o: Observed, key: ConcernKey): number {
  return o.concerns.find(c => c.key === key)?.severity ?? 0;
}

function printTable(rows: { subject: SubjectLabel; observed: Observed }[]): void {
  console.log('\n── Per-subject assessment ' + '─'.repeat(54));
  console.log(
    pad('subject', 16) + pad('fitz', 6) + pad('qual', 7) + pad('skin type', 20) +
    pad('flags', 10) + 'top concerns (severity x confidence)',
  );
  console.log('─'.repeat(120));

  for (const { subject, observed } of rows) {
    if (observed.error) {
      console.log(pad(subject.id, 16) + `ERROR  ${observed.error}`);
      continue;
    }
    const top = [...observed.concerns]
      .sort((a, b) => b.severity - a.severity)
      .slice(0, 4)
      .map(c => `${c.key} ${c.severity.toFixed(2)}x${c.confidence.toFixed(2)}`)
      .join('  ');
    console.log(
      pad(subject.id, 16) +
      pad(subject.fitzpatrick ? `${subject.fitzpatrick}` : '-', 6) +
      pad(observed.imageQuality === null ? '-' : observed.imageQuality.toFixed(2), 7) +
      pad(`${observed.skinType ?? '-'} ${observed.skinTypeConf?.toFixed(2) ?? ''}`, 20) +
      pad(observed.escalated ? 'ESCALATE' : (observed.medicalFlags.join(',') || '-'), 10) +
      top,
    );
  }
}

/** The byte-identical check. With the mock provider every row is the same and
 *  the table above is decoration. */
function checkForIdenticalAssessments(rows: { observed: Observed }[]): boolean {
  const ok = rows.filter(r => !r.observed.error);
  if (ok.length < 2) return false;
  const fingerprint = (o: Observed) =>
    JSON.stringify([o.imageQuality, o.skinType, o.skinTypeConf, o.concerns, o.medicalFlags]);
  const first = fingerprint(ok[0].observed);
  return ok.every(r => fingerprint(r.observed) === first);
}

interface FpRow { key: ConcernKey; labelledAbsent: number; falsePositives: number; worst: number }

function printLabelledMetrics(rows: { subject: SubjectLabel; observed: Observed }[]): void {
  const labelled = rows.filter(r =>
    !r.observed.error && (r.subject.clear || (r.subject.absent?.length ?? 0) > 0 || Object.keys(r.subject.present ?? {}).length > 0),
  );
  if (labelled.length === 0) {
    console.log(
      '\nNo ground-truth labels found, so nothing was scored for accuracy.\n' +
      'Run with --init-labels to scaffold a labels.json, fill in `fitzpatrick`\n' +
      'and `absent` for each subject, and run again.',
    );
    return;
  }

  const absentFor = (s: SubjectLabel): ConcernKey[] => {
    if (s.clear) return CONCERN_KEYS.filter(k => !(s.present && k in s.present));
    return s.absent ?? [];
  };

  // ── False positives: the headline number ──
  const fp = new Map<ConcernKey, FpRow>();
  for (const { subject, observed } of labelled) {
    for (const key of absentFor(subject)) {
      const row = fp.get(key) ?? { key, labelledAbsent: 0, falsePositives: 0, worst: 0 };
      row.labelledAbsent += 1;
      const sev = severityOf(observed, key);
      if (sev > PRESENT_THRESHOLD) row.falsePositives += 1;
      row.worst = Math.max(row.worst, sev);
      fp.set(key, row);
    }
  }

  console.log(`\n── False positives (concern labelled absent, model scored > ${PRESENT_THRESHOLD}) ` + '─'.repeat(20));
  const fpRows = [...fp.values()].sort((a, b) =>
    (b.falsePositives / b.labelledAbsent) - (a.falsePositives / a.labelledAbsent) || b.worst - a.worst);
  if (fpRows.length === 0) {
    console.log('  (no subject has any `absent` entries — this is the field worth filling)');
  } else {
    console.log('  ' + pad('concern', 22) + padL('absent', 8) + padL('FP', 5) + padL('rate', 8) + padL('worst', 8));
    for (const r of fpRows) {
      console.log(
        '  ' + pad(r.key, 22) + padL(String(r.labelledAbsent), 8) + padL(String(r.falsePositives), 5) +
        padL(pct(r.falsePositives / r.labelledAbsent), 8) + padL(r.worst.toFixed(2), 8),
      );
    }
    const totalAbsent = fpRows.reduce((n, r) => n + r.labelledAbsent, 0);
    const totalFp = fpRows.reduce((n, r) => n + r.falsePositives, 0);
    console.log('  ' + pad('OVERALL', 22) + padL(String(totalAbsent), 8) + padL(String(totalFp), 5) +
      padL(pct(totalFp / totalAbsent), 8));
  }

  // ── By Fitzpatrick: the reason this harness exists ──
  const byTone = new Map<number, { n: number; absent: number; fp: number; escalated: number }>();
  for (const { subject, observed } of labelled) {
    const t = subject.fitzpatrick;
    if (!t) continue;
    const b = byTone.get(t) ?? { n: 0, absent: 0, fp: 0, escalated: 0 };
    b.n += 1;
    if (observed.escalated || observed.medicalFlags.length > 0) b.escalated += 1;
    for (const key of absentFor(subject)) {
      b.absent += 1;
      if (severityOf(observed, key) > PRESENT_THRESHOLD) b.fp += 1;
    }
    byTone.set(t, b);
  }

  console.log('\n── By Fitzpatrick type ' + '─'.repeat(57));
  if (byTone.size === 0) {
    console.log('  (no subject has a `fitzpatrick` value — fill this in, it is the whole point)');
  } else {
    const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
    console.log('  ' + pad('type', 8) + padL('subjects', 10) + padL('FP rate', 10) + padL('flagged', 10));
    for (const t of [...byTone.keys()].sort((x, y) => x - y)) {
      const b = byTone.get(t)!;
      console.log(
        '  ' + pad(ROMAN[t] ?? String(t), 8) +
        padL(String(b.n), 10) +
        padL(b.absent ? pct(b.fp / b.absent) : '-', 10) +
        padL(pct(b.escalated / b.n), 10),
      );
    }
    console.log(
      '\n  A false-positive rate that climbs with Fitzpatrick type is the failure\n' +
      '  CLAUDE.md rule 5 is about: the model reading melanin as damage. Cap the\n' +
      '  affected concern weights rather than shipping the raw scores.',
    );
  }

  // ── Severity bias, where truth severities were given ──
  const bias = new Map<ConcernKey, { n: number; sum: number; absSum: number }>();
  for (const { subject, observed } of labelled) {
    for (const [k, truth] of Object.entries(subject.present ?? {})) {
      if (typeof truth !== 'number') continue;
      const key = k as ConcernKey;
      const d = severityOf(observed, key) - truth;
      const b = bias.get(key) ?? { n: 0, sum: 0, absSum: 0 };
      b.n += 1; b.sum += d; b.absSum += Math.abs(d);
      bias.set(key, b);
    }
  }
  if (bias.size > 0) {
    console.log('\n── Severity bias where you gave a truth value ' + '─'.repeat(35));
    console.log('  ' + pad('concern', 22) + padL('n', 5) + padL('mean err', 11) + padL('MAE', 8));
    for (const [key, b] of [...bias.entries()].sort((a, c) => Math.abs(c[1].sum / c[1].n) - Math.abs(a[1].sum / a[1].n))) {
      const mean = b.sum / b.n;
      console.log('  ' + pad(key, 22) + padL(String(b.n), 5) +
        padL(`${mean >= 0 ? '+' : ''}${mean.toFixed(2)}`, 11) + padL((b.absSum / b.n).toFixed(2), 8));
    }
    console.log('  (positive = the model scores it higher than you do)');
  }

  // ── Skin type agreement ──
  const typed = labelled.filter(r => r.subject.skinType);
  if (typed.length > 0) {
    const hits = typed.filter(r => r.subject.skinType === r.observed.skinType).length;
    console.log(`\nSkin type agreement: ${hits}/${typed.length} (${pct(hits / typed.length)})`);
  }
}

function writeCsv(path: string, rows: { subject: SubjectLabel; observed: Observed }[]): void {
  const head = [
    'subject', 'fitzpatrick', 'provider', 'image_quality', 'skin_type', 'skin_type_conf',
    'escalated', 'medical_flags', 'frame_bytes',
    ...CONCERN_KEYS.flatMap(k => [`${k}_sev`, `${k}_conf`]),
  ];
  const lines = [head.join(',')];
  for (const { subject, observed } of rows) {
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    lines.push([
      subject.id, subject.fitzpatrick ?? '', observed.provider, observed.imageQuality ?? '',
      observed.skinType ?? '', observed.skinTypeConf ?? '', observed.escalated,
      observed.medicalFlags.join('|'), observed.bytes,
      ...CONCERN_KEYS.flatMap(k => {
        const c = observed.concerns.find(x => x.key === k);
        return [c?.severity ?? '', c?.confidence ?? ''];
      }),
    ].map(cell).join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n');
  console.log(`\nCSV written to ${path}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(args.dir)) {
    console.error(`No such folder: ${args.dir}`);
    process.exit(1);
  }

  const labelPath = args.labels ?? join(args.dir, 'labels.json');

  if (args.initLabels) {
    if (existsSync(labelPath)) {
      console.error(`${labelPath} already exists. Delete it first, or pass --labels <other path>.`);
      process.exit(1);
    }
    writeLabelTemplate(args.dir, labelPath);
    const n = discoverSubjects(args.dir).length;
    console.log(`Wrote ${labelPath} with ${n} subject(s).`);
    console.log('Fill in `fitzpatrick` and `absent` for each, then run without --init-labels.');
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — the harness reads the');
    console.error('assessment rows directly. Fill in .env.local.');
    process.exit(1);
  }

  let subjects = discoverSubjects(args.dir);
  if (existsSync(labelPath)) {
    const doc = JSON.parse(readFileSync(labelPath, 'utf8')) as LabelFile;
    const byId = new Map(doc.subjects.map(s => [s.id, s]));
    subjects = subjects.map(s => {
      const label = byId.get(s.id);
      // Discovered frames win: the folder is the source of truth for what
      // exists, the labels file for what it means.
      return label ? { ...label, frames: s.frames } : s;
    });
    console.log(`Labels: ${labelPath} (${doc.subjects.length} entries)`);
  } else {
    console.log(`No labels at ${labelPath} — reporting raw assessments only.`);
  }

  if (subjects.length === 0) {
    console.error(`No images found in ${args.dir}`);
    process.exit(1);
  }

  console.log(`Base: ${args.base}`);
  console.log(`Subjects: ${subjects.length}  ·  frames centre-cropped square, max ${args.maxEdge}px, JPEG q90\n`);

  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const rows: { subject: SubjectLabel; observed: Observed }[] = [];
  for (const subject of subjects) {
    process.stdout.write(`  ${subject.id} … `);
    const observed = await runSubject(args, db, subject);
    rows.push({ subject, observed });
    console.log(observed.error ? `FAILED (${observed.error})` : 'ok');
  }

  printTable(rows);

  if (checkForIdenticalAssessments(rows)) {
    console.log(
      '\n' + '!'.repeat(72) + '\n' +
      '!  EVERY ASSESSMENT IS IDENTICAL. The frames were not analysed.\n' +
      '!\n' +
      '!  VISION_PROVIDER=mock serves a fixed DEMO_PRESET and never looks at the\n' +
      '!  images. Nothing above tells you anything about these faces, and no\n' +
      '!  accuracy number below is real. Point this at a deployment running a\n' +
      '!  vendor adapter before you believe a single figure.\n' +
      '!'.repeat(72),
    );
  }

  printLabelledMetrics(rows);

  if (args.csv) writeCsv(resolve(args.csv), rows);

  const failures = rows.filter(r => r.observed.error).length;

  if (!args.keep) {
    const repo = createRepo(db);
    let cleaned = 0;
    for (const { observed } of rows) {
      if (!observed.sessionId) continue;
      try { await repo.deleteAllForSession(observed.sessionId); cleaned++; } catch { /* report below */ }
    }
    console.log(`\nCleaned up ${cleaned} calibration session(s). Pass --keep to leave them in place.`);
  }

  if (failures > 0) {
    console.error(`\n${failures} subject(s) failed.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
