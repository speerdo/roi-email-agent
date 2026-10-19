// lib/brands/index.ts
//
// The brand registry. App code resolves a profile with getBrand(id) and
// never hardcodes brand values. ROI is the only brand for now; Task 3
// wires the DB `brand` column and /api/poll?brand= to this registry.

import type { BrandProfile } from './types.js';
import { ROI_BRAND } from './roi.js';
import { DOWNTOWNDRY_BRAND } from './downtowndry.js';
import { EBIKELOCAL_BRAND } from './ebikelocal.js';

export type { BrandProfile, BrandPrefilterConfig, BrandSignatureConfig } from './types.js';

const REGISTRY: Readonly<Record<string, BrandProfile>> = {
  [ROI_BRAND.id]: ROI_BRAND,
  [DOWNTOWNDRY_BRAND.id]: DOWNTOWNDRY_BRAND,
  [EBIKELOCAL_BRAND.id]: EBIKELOCAL_BRAND,
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

/** Non-throwing variant for untrusted input (?brand= query params).
 *  Returns null on an unknown id so callers can 400 cleanly. */
export function tryGetBrand(id: string | undefined): BrandProfile | null {
  if (!id) return DEFAULT_BRAND;
  return REGISTRY[id] ?? null;
}

/** Per-brand poll cursor key. Each brand owns an independent lastUid so
 *  DD's poll never resumes from ROI's position (or vice versa).
 *  Migration 0005 adopts the pre-existing ROI row under this key. */
export function syncKeyFor(brand: BrandProfile): string {
  return `${brand.id}:INBOX`;
}

/** The brand used until Task 3 lands the multi-brand wiring. */
export const DEFAULT_BRAND = ROI_BRAND;
