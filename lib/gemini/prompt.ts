// lib/gemini/prompt.ts
//
// The Gemini system prompt now lives in the brand profile
// (lib/brands/roi.ts) so each brand carries its own. This module
// re-exports the active brand's prompt — a single constant so a prompt
// tweak is a one-file diff in lib/brands/<brand>.ts and reviewers can
// audit the model's instructions in one place.
//
// House style rules to preserve across edits:
//   - No em dashes ("--" or "—" must NOT appear in draft_reply output).
//   - NO sign-off in draft_reply. The branded signature block
//     (lib/mail/signature.ts) is appended at send time and already
//     carries the name and site; anything the model signs is stripped by
//     stripDraftSignoff() before the draft is stored.
//   - Listing request drafts MUST point at https://recycleoldtech.com/claims
//     and NOT ask the recycler to email details back (the form captures them).
//   - Out-of-scope replies are short, polite, honest declines that do NOT
//     invent or imply a service we don't offer.
//   - recycling_help drafts MUST be left empty ("") — code composes the reply
//     from a deterministic template using the extracted location fields and
//     a real city-page URL looked up from the site's own index. The model
//     MUST NEVER emit a recycleoldtech.com URL for this category (a
//     hallucinated /states/pennsylvania/greencastle-township 404s and the
//     lead is dead). See docs/SPEC_TRIAGE_FIXES.md §2.5.

import { DEFAULT_BRAND } from '../brands/index.js';

/** Back-compat export: the DEFAULT_BRAND (ROI) prompt. The live classify
 *  path uses the per-brand profile instead — classifyAndDraft(msg, brand)
 *  sends brand.systemPrompt — so this only matters for scripts/tests that
 *  still import it. */
export const SYSTEM_PROMPT = DEFAULT_BRAND.systemPrompt;

/**
 * Builds the user-content portion of the generateContent call: just the
 * email fields, formatted for the model. SYSTEM_PROMPT carries all the
 * instructions and is sent once via `systemInstruction`; this stays a
 * separate, minimal block so the prompt isn't duplicated into `contents`.
 */
export function buildUserContent(msg: { from: string; subject: string; snippet: string }): string {
  return `Email:
From: ${msg.from}
Subject: ${msg.subject}
Body: ${msg.snippet}`;
}
