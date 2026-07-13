/**
 * Server-side dependency selection: which repo and which vision provider this
 * deployment runs on. Both choices are env-driven and loud — no silent
 * fallbacks in production paths.
 */

import { createClient } from '@supabase/supabase-js';
import { createRepo, type SkinRepo } from '@/lib/db/repo';
import { createMemoryRepo } from '@/lib/db/memory';
import { MockVisionProvider } from '@/lib/vision/mock';
import type { SkinVisionProvider } from '@/lib/vision/provider';
import type { ConcernScore, SkinAssessment, SkinType } from '@/lib/vision/types';
import { ApiError } from './http';

let repo: SkinRepo | undefined;
let warnedMemory = false;

export function getRepo(): SkinRepo {
  if (!repo) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      repo = createRepo(createClient(url, key, { auth: { persistSession: false } }));
    } else {
      if (!warnedMemory) {
        console.warn(
          '[skin-api] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — running on the IN-MEMORY repo '
          + '(testing ladder stage 1, spec §14). Data is process-local and lost on restart.',
        );
        warnedMemory = true;
      }
      repo = createMemoryRepo();
    }
  }
  return repo;
}

const SKIN_TYPES: SkinType[] = ['dry', 'oily', 'combination', 'normal', 'sensitive'];

/**
 * Returns the configured vision provider for one /analyze call.
 *
 * Mock mode (default until a real adapter lands): the caller must supply the
 * assessment the "camera" would have produced. This is the seam the testing
 * ladder's stage 1–2 runs through. It is rejected outright once a real
 * provider is configured — a client can never inject an assessment in
 * production.
 */
export function getVisionProvider(mockAssessment: unknown): SkinVisionProvider {
  const which = process.env.VISION_PROVIDER ?? 'mock';
  if (which !== 'mock') {
    if (mockAssessment !== undefined)
      throw new ApiError(400, `mockAssessment is not accepted when VISION_PROVIDER=${which}`);
    // hautai / perfectCorp adapters are pending (spec §16). Fail loud, never fall back.
    throw new ApiError(501, `vision provider '${which}' is not implemented yet`);
  }
  return new MockVisionProvider(validateMockAssessment(mockAssessment));
}

function validateMockAssessment(x: unknown): SkinAssessment {
  const bad = (why: string): never => {
    throw new ApiError(400, `mockAssessment ${why} (required while VISION_PROVIDER=mock — testing ladder stage 1)`);
  };
  if (x === undefined || x === null) bad('missing');
  const a = x as Record<string, unknown>;
  if (typeof a !== 'object' || Array.isArray(a)) bad('must be an object');

  const skinType = a.skinType as { value?: unknown; confidence?: unknown } | undefined;
  if (!skinType || !SKIN_TYPES.includes(skinType.value as SkinType)) bad('needs skinType.value of dry|oily|combination|normal|sensitive');
  if (typeof skinType!.confidence !== 'number') bad('needs numeric skinType.confidence');

  if (!Array.isArray(a.concerns)) bad('needs concerns array');
  for (const c of a.concerns as ConcernScore[]) {
    if (typeof c?.key !== 'string' || typeof c?.severity !== 'number' || typeof c?.confidence !== 'number')
      bad('concerns entries need {key, severity, confidence}');
  }
  if (typeof a.imageQualityScore !== 'number') bad('needs numeric imageQualityScore');
  if (!Array.isArray(a.medicalFlags) || (a.medicalFlags as unknown[]).some(f => typeof f !== 'string'))
    bad('needs medicalFlags string array');
  if (typeof a.provider !== 'string' || a.provider.length === 0) bad('needs provider string');

  return {
    provider: a.provider as string,
    imageQualityScore: a.imageQualityScore as number,
    medicalFlags: a.medicalFlags as string[],
    concerns: a.concerns as ConcernScore[],
    skinType: { value: skinType!.value as SkinType, confidence: skinType!.confidence as number },
  };
}
