import type { SkinAssessment } from './types';
import type { SkinVisionProvider } from './provider';

/** Mock vision provider — swap for a real adapter later. */
export class MockVisionProvider implements SkinVisionProvider {
  constructor(private preset: SkinAssessment) {}
  async analyze(_frames: unknown): Promise<SkinAssessment> {
    return JSON.parse(JSON.stringify(this.preset));   // deep copy, like a real network return
  }
}
