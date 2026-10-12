// lib/brands/index.ts
//
// The brand registry. App code resolves a profile with getBrand(id) and
// never hardcodes brand values. ROI is the only brand for now; Task 3
// wires the DB `brand` column and /api/poll?brand= to this registry.

import type { BrandProfile } from './types.js';
import { ROI_BRAND } from './roi.js';

export type { BrandProfile, BrandPrefilterConfig, BrandSignatureConfig } from './types.js';

const REGISTRY: Readonly<Record<string, BrandProfile>> = {
  [ROI_BRAND.id]: ROI_BRAND,
};

/** Every registered brand profile. */
export function listBrands(): readonly BrandProfile[] {
  return Object.values(REGISTRY);
}

/** Resolve a brand by id. Throws on an unknown id — a missing brand is a
 *  configuration bug (bad env var / DB value), not a runtime fallback. */
export function getBrand(id: string): BrandProfile {
  const brand = REGISTRY[id];
  if (!brand) {
    throw new Error(`Unknown brand id: ${id} (registered: ${Object.keys(REGISTRY).join(', ')})`);
  }
  return brand;
}

/** The brand used until Task 3 lands the multi-brand wiring. */
export const DEFAULT_BRAND = ROI_BRAND;
