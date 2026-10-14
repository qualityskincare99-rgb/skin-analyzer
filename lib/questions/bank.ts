import type { ConcernKey } from '../vision/types';

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

  // Safety-screen questions — asked in TRIAGE on every consultation (see
  // questions/triage.ts); route to escalation, never to a product.
  // selectQuestions() excludes them from the main consult by targets.length.
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
