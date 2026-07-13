import type { Scored } from './engine';

export function timelineFor(s: Scored): string {
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
