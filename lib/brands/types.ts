// lib/brands/types.ts
//
// The BrandProfile contract: everything that varies between the email
// brands this agent can operate. A brand is identified by `id`; the
// registry (lib/brands/index.ts) resolves profiles so the rest of the
// app never hardcodes RecycleOldTech values. lib/brands/roi.ts holds the
// first profile; DowntownDry and future brands add one file each.

/** Deterministic pre-filter defaults for this brand. The matcher itself
 *  (lib/mail/prefilter.ts) still reads its env vars directly — this
 *  carries the brand-level defaults Task 3 will wire per-brand. */
export interface BrandPrefilterConfig {
  automatedFormMarkRead: boolean;
  newsletterMarkRead: boolean;
  dmarcMarkRead: boolean;
}

/** Signature block inputs. The logo is embedded inline (cid:) by
 *  lib/mail/signature.ts; paths are resolved relative to the project
 *  root so they work under `vercel dev` and in the Vercel build. */
export interface BrandSignatureConfig {
  /** First line of the signature ("Adam"). */
  name: string;
  /** Linked site label shown under the name ("recycleoldtech.com"). */
  siteLabel: string;
  /** Where the site label links to. */
  siteUrl: string;
  /** Logo path, relative to the project root. */
  logoPath: string;
  /** Content-ID used by the inline <img src="cid:...">. */
  logoCid: string;
  /** Attachment filename for the embedded logo. */
  logoFilename: string;
}

export interface BrandProfile {
  /** Registry key (e.g. "roi"). Also the `brand` column value from
   *  Task 3 onward. */
  id: string;
  /** Canonical site domain (no scheme). */
  domain: string;
  /** Display name used in the SMTP From header. */
  fromName: string;
  /** Full Gemini system prompt for this brand. */
  systemPrompt: string;
  /** Every classify category this brand's prompt may emit. */
  categories: readonly string[];
  prefilter: BrandPrefilterConfig;
  signature: BrandSignatureConfig;
  /** Draft sign-off patterns the stripper drops from the END of a
   *  draft before the branded signature is appended (see
   *  lib/mail/signature.ts stripDraftSignoff). */
  signoffPatterns: readonly RegExp[];
}
