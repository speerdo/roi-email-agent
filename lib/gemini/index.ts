import { GoogleGenAI } from '@google/genai';
import { getEnv } from '../env.js';
import { DEFAULT_BRAND, type BrandProfile } from '../brands/index.js';
import { buildUserContent } from './prompt.js';

// ---- Public types ---------------------------------------------------------

export type GeminiCategory =
  | 'recycling_help'
  | 'listing_request'
  | 'partner_inquiry'
  | 'support'
  | 'claim'
  | 'out_of_scope'
  | 'spam'
  | 'other';

/** Optional location block extracted from a recycling_help request. The
 *  model emits this only when the sender actually stated a place; we never
 *  guess from area code, email domain, or signature. Code looks up the
 *  city-page URL from this — the model must NEVER emit a recycleoldtech.com
 *  URL itself (hallucinated paths 404 and kill the lead). */
export interface ClassifyLocation {
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface ClassifyResult {
  /** One of the brand's categories (lib/brands/<brand>.ts categories).
   *  Kept as plain string so per-brand category vocabularies typecheck;
   *  parseClassifyResult guarantees membership in the brand's set
   *  (falling back to 'other'). */
  category: string;
  should_reply: boolean;
  draft_reply: string;
  reason: string;
  /** Present only for recycling_help. Null otherwise. The model may omit
   *  it even for recycling_help (e.g. no location stated); code falls back
   *  to template D. */
  location?: ClassifyLocation | null;
  /** Free-text item list from the sender ("TVs", "old computers"). Nice-to-
   *  have for reporting; not used to drive routing. */
  items?: string[] | null;
  /** Help-type vocabulary mirrored from RecyclingRequestForm.astro
   *  (drop off / schedule pickup / business cleanout / data destruction /
   *  sell-buy). Optional, for reporting parity with real form submissions. */
  help_type?: string | null;
  /** The human's name as stated in the email body. Needed because the From
   *  display name is useless for form submissions — Web3Forms sends
   *  `From: "Notifications" <notify@web3forms.com>` with the real name in
   *  the body ("name : Fred Buczynski"), so greeting off the header would
   *  address the sender as "Hi Notifications". Null when not stated. */
  sender_name?: string | null;
  /** Raw model output, kept for diagnostics on parse failure. */
  raw?: string;
}

export interface ClassifyInput {
  from: string;
  subject: string;
  snippet: string;
}

// ---- Client singleton -----------------------------------------------------

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const env = getEnv();
  cachedClient = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}

/** Reset the cached client — for tests. */
export function resetGeminiClient(): void {
  cachedClient = null;
}

// ---- Helpers --------------------------------------------------------------

/** ROI's category set. Used as the default when no brand is supplied
 *  (back-compat for scripts/tests); the live poll path always passes the
 *  brand profile, so VALID_CATEGORIES is effectively per brand. */
const ROI_CATEGORIES: ReadonlySet<string> = new Set<GeminiCategory>([
  'recycling_help',
  'listing_request',
  'partner_inquiry',
  'support',
  'claim',
  'out_of_scope',
  'spam',
  'other',
]);

function validCategoriesFor(brand?: BrandProfile): ReadonlySet<string> {
  if (!brand) return ROI_CATEGORIES;
  return new Set<string>(brand.categories);
}

/**
 * Defensive JSON parse: strip accidental markdown fences, ignore trailing
 * prose before/after the JSON object, parse, validate the shape. On any
 * failure return an 'other' / should_reply=false result with raw attached
 * so the DB row still records what happened.
 *
 * Plan §9: "Parse defensively: strip accidental \`\`\` fences before
 * JSON.parse; on parse failure, set category=other, should_reply=false,
 * log raw."
 */
export function parseClassifyResult(
  raw: string,
  validCategories: ReadonlySet<string> = ROI_CATEGORIES,
): ClassifyResult {
  const trimmed = raw.trim();
  // Strip ``` fences if present (model occasionally wraps despite
  // responseMimeType=application/json).
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const withoutFences = fenceMatch?.[1] ?? trimmed;

  // Find the first { and the matching last } to tolerate any leading/trailing
  // prose the model might emit despiteJSON-mode.
  const first = withoutFences.indexOf('{');
  const last = withoutFences.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    return {
      category: 'other',
      should_reply: false,
      draft_reply: '',
      reason: 'parse_failed: no JSON object found',
      location: null,
      items: null,
      help_type: null,
      sender_name: null,
      raw,
    };
  }
  const jsonSlice = withoutFences.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    const e = err as Error;
    return {
      category: 'other',
      should_reply: false,
      draft_reply: '',
      reason: `parse_failed: ${e.message}`,
      location: null,
      items: null,
      help_type: null,
      sender_name: null,
      raw,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      category: 'other',
      should_reply: false,
      draft_reply: '',
      reason: 'parse_failed: parsed is not an object',
      location: null,
      items: null,
      help_type: null,
      sender_name: null,
      raw,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const rawCategory = typeof obj.category === 'string' ? obj.category : 'other';
  const category: string = validCategories.has(rawCategory) ? rawCategory : 'other';
  const should_reply = obj.should_reply === true;
  const draft_reply = typeof obj.draft_reply === 'string' ? obj.draft_reply : '';
  const reason = typeof obj.reason === 'string' ? obj.reason : '';

  // Optional location/items/help_type — only meaningful for recycling_help,
  // but tolerate them on any category (defensive parse). All three default
  // to null when missing or malformed so downstream code can branch on
  // null without a separate "was it present" check.
  const location = parseLocation(obj.location);
  const items = parseStringArray(obj.items);
  const help_type = typeof obj.help_type === 'string' && obj.help_type.length > 0 ? obj.help_type : null;
  const sender_name =
    typeof obj.sender_name === 'string' && obj.sender_name.trim().length > 0
      ? obj.sender_name.trim()
      : null;

  return { category, should_reply, draft_reply, reason, location, items, help_type, sender_name };
}

/** Parse the optional `location` block into a ClassifyLocation, tolerating
 *  missing/garbage values. Never throws. */
function parseLocation(raw: unknown): ClassifyLocation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const city = typeof obj.city === 'string' && obj.city.length > 0 ? obj.city.trim() : null;
  const state = typeof obj.state === 'string' && obj.state.length > 0 ? obj.state.trim() : null;
  const zip = typeof obj.zip === 'string' && obj.zip.length > 0 ? obj.zip.trim() : null;
  if (city === null && state === null && zip === null) return null;
  return { city, state, zip };
}

/** Parse an optional string array, tolerating non-array / non-string
 *  elements. Returns null when absent or empty. */
function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const el of raw) {
    if (typeof el === 'string' && el.length > 0) out.push(el.trim());
  }
  return out.length > 0 ? out : null;
}

/**
 * Whether a thrown error from the Gemini SDK is worth retrying. The SDK
 * throws `ApiError` with a numeric `status` field (HTTP status code).
 * Retry on 5xx (server error, transient) and 429 (rate limit). Do NOT
 * retry 4xx (including 404 for a retired model id — that needs a prompt
 * + env update, not a retry) — surface those as error rows immediately
 * so the Phase 9 alert fires.
 */
function isRetryableGeminiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; statusCode?: unknown; message?: string };
  const status =
    typeof e.status === 'number' ? e.status :
    typeof e.statusCode === 'number' ? e.statusCode :
    undefined;
  if (status === undefined) {
    // Fall back to message sniffing for SDK wrappers that don't surface
    // a numeric status (e.g. fetch-level errors with "429" in the body).
    const msg = typeof e.message === 'string' ? e.message : '';
    return /\b5\d\d\b|\b429\b/.test(msg);
  }
  return (status >= 500 && status < 600) || status === 429;
}

// ---- Public API -----------------------------------------------------------

/**
 * Single-call classify + draft per plan §9. Calls GEMINI_MODEL with JSON
 * mode and parses the result defensively.
 *
 * SPEC §3.9: one retry with jittered backoff on 5xx/429. A transient
 * Gemini outage or a model retirement (404) used to make the message an
 * unrecoverable `error` row — the cursor passed it via dedupe but nothing
 * ever retried it. The retry covers the common 5xx/429 case; a 404 on a
 * retired model id still throws (and lands as an error row + Phase 9
 * alert so Adam can update GEMINI_MODEL).
 *
 * Phase 9 will split this into a classify call (GEMINI_CLASSIFY_MODEL,
 * flash-lite) and a draft call (GEMINI_MODEL, only when should_reply is
 * true). For now both steps happen in this single call; the structure is
 * arranged so the split is a one-line change later — see draftOnly().
 */
export async function classifyAndDraft(
  msg: ClassifyInput,
  brand: BrandProfile = DEFAULT_BRAND,
): Promise<ClassifyResult> {
  const env = getEnv();
  const client = getClient();
  const contents = buildUserContent(msg);
  const validCategories = validCategoriesFor(brand);

  const config = {
    // The brand's system prompt (instructions only) goes via
    // systemInstruction; `contents` carries just the email fields from
    // buildUserContent. Keeping these separate avoids sending the (large)
    // instruction block twice per call.
    systemInstruction: brand.systemPrompt,
    responseMimeType: 'application/json' as const,
    temperature: 0.2, // deterministic-leaning for classification
  };

  let response;
  try {
    response = await client.models.generateContent({
      model: env.GEMINI_MODEL,
      contents,
      config,
    });
  } catch (err) {
    // SPEC §3.9: one retry with jittered backoff on 5xx/429. 404 (retired
    // model) and other 4xx are NOT retried — they'll fail the same way
    // again and should surface as an error row + alert immediately.
    if (!isRetryableGeminiError(err)) throw err;
    const backoff = 800 + Math.random() * 1200; // 0.8-2.0s, jittered
    await new Promise((r) => setTimeout(r, backoff));
    response = await client.models.generateContent({
      model: env.GEMINI_MODEL,
      contents,
      config,
    });
  }

  const text = (typeof response.text === 'string' ? response.text : '') ?? '';
  if (text.length === 0) {
    return {
      category: 'other',
      should_reply: false,
      draft_reply: '',
      reason: 'gemini returned empty text',
      location: null,
      items: null,
      help_type: null,
      sender_name: null,
      raw: '',
    };
  }
  return parseClassifyResult(text, validCategories);
}

/**
 * Stub for Phase 9's split classify/draft path. When implemented, this
 * will take a known category + email and produce only the draft via
 * GEMINI_MODEL, saving the flash-lite classify cost on the spam majority.
 *
 * Phase 8's backlog-draft mode can call this once it exists. For now it
 * just calls classifyAndDraft and discards the category — same cost, but
 * only the draft is consumed downstream.
 */
export async function draftOnly(msg: ClassifyInput, _category: GeminiCategory): Promise<string> {
  const result = await classifyAndDraft(msg);
  return result.draft_reply;
}