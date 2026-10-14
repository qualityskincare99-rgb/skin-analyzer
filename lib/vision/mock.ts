import type { SkinAssessment } from './types';
import type { SkinVisionProvider } from './provider';

/**
 * Preset returned when the client uploads real frames while VISION_PROVIDER is
 * still `mock` — i.e. the UI drives the whole flow end to end before a vendor
 * adapter exists. It is a FIXED assessment: the frames are not read. Every
 * capture produces this same result until hautai.ts / perfectCorp.ts land.
 */
export const DEMO_PRESET: SkinAssessment = {
  provider: 'mock',
  imageQualityScore: 0.9,
  medicalFlags: [],
  skinType: { value: 'combination', confidence: 0.78 },
  concerns: [
    { key: 'acne', severity: 0.45, confidence: 0.76 },
    { key: 'excess_oil', severity: 0.55, confidence: 0.8 },
    { key: 'hyperpigmentation', severity: 0.4, confidence: 0.7 },
    { key: 'enlarged_pores', severity: 0.35, confidence: 0.72 },
  ],
};

/** Mock vision provider — swap for a real adapter later. */
export class MockVisionProvider implements SkinVisionProvider {
  constructor(private preset: SkinAssessment) {}
  async analyze(_frames: unknown): Promise<SkinAssessment> {
    return JSON.parse(JSON.stringify(this.preset));   // deep copy, like a real network return
  }
}
