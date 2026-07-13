import type { ConcernKey, SkinAssessment } from '../vision/types';
import { CATALOG, type Product, type Slot, type TimeOfDay } from './catalog';
import { explain } from './explain';
import { timelineFor } from './timelines';

export interface Driver { concern: ConcernKey; contrib: number; }
export interface Scored { product: Product; score: number; drivers: Driver[]; }

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

// RECOMMENDATION ENGINE  (weighted scoring, not keyword matching)

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
