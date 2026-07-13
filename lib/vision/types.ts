/**
 * Normalized vision types. Everything downstream of the vision layer consumes
 * a `SkinAssessment` — never a provider's raw payload.
 */

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
