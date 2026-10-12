// lib/brands/types.ts
//
// The BrandProfile contract: everything that varies between the email
// brands this agent can operate. A brand is identified by `id`; the
// registry (lib/brands/index.ts) resolves profiles so the rest of the
// app never hardcodes RecycleOldTech values. lib/brands/roi.ts holds the
// first profile; DowntownDry and future brands add one file each.

/** Deterministic pre-filter configuration for this brand.
 *
 *  Resolution (lib/mail/prefilter.ts prefilterConfigFor): the ROI brand
 *  keeps reading its config from the AUTOMATED_FORM_* / NEWSLETTER_* /
 *  DMARC_* env vars at runtime (behavior unchanged, ops can tune without a
 *  deploy); every OTHER brand uses this static config verbatim.
 *
 *  An empty automatedFormSubjects / automatedFormFrom means "no automated
 *  form filter" — DowntownDry uses that so its Web3Forms contact form
 *  reaches Gemini. */
export interface BrandPrefilterConfig {
  automatedFormSubjects: readonly string[];
  automatedFormFrom: string;
  automatedFormMarkRead: boolean;
  newsletterFrom: string;
  newsletterSubjects: readonly string[];
  newsletterMarkRead: boolean;
  dmarcSubjects: readonly string[];
  dmarcFrom: string;
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
  /** Display width of the logo in the signature, in px. */
  logoWidth: number;
  /** Display height of the logo in the signature, in px (the intrinsic
   *  ratio must match, so clients that ignore CSS don't squash it). */
  logoHeight: number;
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
  /** Prefix for this brand's own env vars (e.g. "DD" -> DD_EMAIL_USER,
   *  DD_EMAIL_PASS, DD_DISCORD_CHANNEL_ID). Empty string means the brand
   *  uses the shared EMAIL_* / DISCORD_CHANNEL_ID vars (ROI, unchanged). */
  envPrefix: string;
  /** Full Gemini system prompt for this brand. */
  systemPrompt: string;
  /** Every classify category this brand's prompt may emit. */
  categories: readonly string[];
  prefilter: BrandPrefilterConfig;
  /** Prefix shown at the start of this brand's Discord card titles
   *  ("[ROI] Subject") so approval channels with several brands stay
   *  readable at a glance. */
  cardPrefix: string;
  /** When true, messages matching the newsletter pre-filter are parsed
   *  (`email : x` in the body, page name in the subject suffix), upserted
   *  into newsletter_subscribers, and announced once to the brand's
   *  Discord channel. DowntownDry only — ROI's newsletters are Waste
   *  Advantage noise that just gets marked read. */
  newsletterSubscribers: boolean;
  signature: BrandSignatureConfig;
  /** Draft sign-off patterns the stripper drops from the END of a
   *  draft before the branded signature is appended (see
   *  lib/mail/signature.ts stripDraftSignoff). */
  signoffPatterns: readonly RegExp[];
}
