import type { ConcernKey, SkinType } from '../vision/types';

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

// PRODUCT CATALOG  (the IP — tune these weights against real captures)
export const CATALOG: Product[] = [
  { sku: 'QSC-BFW', name: 'Beauty Kit Brightening Face Wash', slot: 'cleanser', time: 'both', medical: false,
    addresses: { dullness: 0.7, uneven_tone: 0.6, hyperpigmentation: 0.4, dark_spots: 0.4 },
    suitsSkinType: ['normal', 'dry', 'combination'] },

  { sku: 'QSC-SPF50', name: 'R&K Sunblock SPF 50', slot: 'sunscreen', time: 'am', medical: false,
    addresses: { sun_damage: 0.9, hyperpigmentation: 0.6, dark_spots: 0.6, uneven_tone: 0.4, acne: 0.2 },
    suitsSkinType: ['dry', 'oily', 'combination', 'normal', 'sensitive'] },

  { sku: 'QSC-NC', name: 'Beauty Kit Night Cream', slot: 'moisturizer', time: 'pm', medical: false,
    addresses: { dry_patches: 0.8, dehydration: 0.8, fine_lines: 0.6, wrinkles: 0.5 },
    suitsSkinType: ['dry', 'normal', 'combination', 'sensitive'] },

  { sku: 'QSC-BC', name: 'Beauty Kit Brightening Cream', slot: 'treatment', time: 'pm', medical: false,
    addresses: { hyperpigmentation: 0.9, dark_spots: 0.85, uneven_tone: 0.8, dullness: 0.6 },
    suitsSkinType: ['normal', 'dry', 'combination', 'oily'],
    cautions: ['Introduce gradually — can irritate sensitive skin', 'Always pair with daily SPF'] },

  { sku: 'QSC-AAFW', name: 'Q-Bellez Acne Face Wash', slot: 'cleanser', time: 'both', medical: false,
    addresses: { acne: 0.85, excess_oil: 0.8, enlarged_pores: 0.5 },
    suitsSkinType: ['oily', 'combination'] },

  { sku: 'QSC-AAC', name: 'Q-Bellez Acne Cream', slot: 'treatment', time: 'pm', medical: false,
    addresses: { acne: 0.9, acne_scars: 0.3 },
    suitsSkinType: ['oily', 'combination', 'normal'],
    cautions: ['Spot-apply only', 'Do not combine with strong exfoliants the same night'] },

  { sku: 'QSC-AAS', name: 'Q-Bellez Acne Soap Bar', slot: 'cleanser', time: 'both', medical: false,
    addresses: { acne: 0.7, excess_oil: 0.7 },
    suitsSkinType: ['oily', 'combination'] },

  { sku: 'QSC-BS', name: 'Beauty Kit Brightening Soap Bar', slot: 'cleanser', time: 'both', medical: false,
    addresses: { dullness: 0.6, uneven_tone: 0.5, hyperpigmentation: 0.4 },
    suitsSkinType: ['normal', 'oily', 'combination'] },

  // ── MEDICAL: hard-gated. Never scored, never auto-recommended. ──
  { sku: 'QSC-STS', name: 'ScabQ Scabies Treatment Soap', slot: 'cleanser', time: 'both', medical: true,
    addresses: {}, suitsSkinType: [] },
  { sku: 'QSC-AFS', name: 'FungZap Anti Fungal Soap', slot: 'cleanser', time: 'both', medical: true,
    addresses: {}, suitsSkinType: [] },
];
