import { GoogleGenAI } from '@google/genai';
import { getEnv } from '../env.js';
import { SYSTEM_PROMPT, buildUserContent } from './prompt.js';

// ---- Public types ---------------------------------------------------------

export type GeminiCategory =
  | 'listing_request'
  | 'partner_inquiry'
  | 'support'
  | 'claim'
  | 'out_of_scope'
  | 'spam'
  | 'other';

export interface ClassifyResult {
  category: GeminiCategory;
  should_reply: boolean;
  draft_reply: string;
  reason: string;
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

const VALID_CATEGORIES: ReadonlySet<string> = new Set<GeminiCategory>([
  'listing_request',
  'partner_inquiry',
  'support',
  'claim',
  'out_of_scope',
  'spam',
  'other',
]);

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
export function parseClassifyResult(raw: string): ClassifyResult {
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
      raw,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      category: 'other',
      should_reply: false,
      draft_reply: '',
      reason: 'parse_failed: parsed is not an object',
      raw,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const rawCategory = typeof obj.category === 'string' ? obj.category : 'other';
  const category: GeminiCategory = VALID_CATEGORIES.has(rawCategory)
    ? (rawCategory as GeminiCategory)
    : 'other';
  const should_reply = obj.should_reply === true;
  const draft_reply = typeof obj.draft_reply === 'string' ? obj.draft_reply : '';
  const reason = typeof obj.reason === 'string' ? obj.reason : '';

  return { category, should_reply, draft_reply, reason };
}

// ---- Public API -----------------------------------------------------------

/**
 * Single-call classify + draft per plan §9. Calls GEMINI_MODEL with JSON
 * mode and parses the result defensively.
 *
 * Phase 9 will split this into a classify call (GEMINI_CLASSIFY_MODEL,
 * flash-lite) and a draft call (GEMINI_MODEL, only when should_reply is
 * true). For now both steps happen in this single call; the structure is
 * arranged so the split is a one-line change later — see draftOnly().
 */
export async function classifyAndDraft(msg: ClassifyInput): Promise<ClassifyResult> {
  const env = getEnv();
  const client = getClient();
  const contents = buildUserContent(msg);

  const response = await client.models.generateContent({
    model: env.GEMINI_MODEL,
    contents,
    config: {
      // SYSTEM_PROMPT (instructions only) goes via systemInstruction;
      // `contents` carries just the email fields from buildUserContent.
      // Keeping these separate avoids sending the (large) instruction
      // block twice per call.
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      temperature: 0.2, // deterministic-leaning for classification
    },
  });

  const text = (typeof response.text === 'string' ? response.text : '') ?? '';
  if (text.length === 0) {
    return {
      category: 'other',
      should_reply: false,
      draft_reply: '',
      reason: 'gemini returned empty text',
      raw: '',
    };
  }
  return parseClassifyResult(text);
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