import type { ConcernKey, SkinAssessment } from '../vision/types';
import type { Scored } from './engine';

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
