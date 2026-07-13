import type { SkinAssessment } from './types';

/**
 * The swappable vision interface. Swapping providers (Haut.AI, Perfect Corp,
 * mock) must never require changes outside /lib/vision.
 */
export interface SkinVisionProvider {
  analyze(frames: unknown): Promise<SkinAssessment>;
}
