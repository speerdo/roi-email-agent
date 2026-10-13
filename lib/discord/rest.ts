// lib/discord/rest.ts — Discord REST API helpers for the triage flow:
//   - postCard(row)         -> post a new approval card with action buttons
//   - editCard(...)         -> update a card after action (Sent/Skipped, strip buttons)
//   - deferInteraction(...) -> type 5 ACK so we have time for SMTP inside Discord's 3s window
//   - openEditModal(...)    -> type 9 modal with prefilled draft_reply paragraph input
//
// All calls use the bot token + channel id from getDiscordEnv(). We do NOT
// cache a token (Discord bot tokens are static until rotated) and we do NOT
// share a connection (REST, not gateway — each call is its own HTTPS POST).

import { getDiscordEnv } from '../../types/env.js';
import { requireBrandEnv } from '../brands/env.js';
import type { BrandProfile } from '../brands/index.js';
import { buildCustomId } from './verify.js';
import { InteractionResponseType, type InteractionType } from 'discord-interactions';
import { recipientDisplay } from '../mail/recipient.js';

// ---- Public types ---------------------------------------------------------

/** Subset of email_queue row the card needs. Loosely typed so callers can pass a pick. */
export interface CardRow {
  id: string;
  fromAddr: string;
  fromName: string | null;
  /** Reply-To header (nullable). When present, replies go here instead of
   *  fromAddr. Shown on the card so a reviewer can see the rerouting. */
  replyTo: string | null;
  subject: string | null;
  category: string | null;
  draftReply: string | null;
  /** Cleaned original-email snippet (lib/mail/clean.ts), shown alongside the draft so a reviewer can judge alignment without leaving Discord. */
  bodySnippet: string | null;
  receivedAt: Date | null;
  /** recycling_help routing hint (e.g. "Greencastle, PA -> /states/...").
   *  Empty/null for non-recycling_help categories. Shown as a card field
   *  so a reviewer can catch a bad city resolution BEFORE approving. */
  routing: string | null;
}

export interface PostedCard {
  messageId: string;
  channelId: string;
}

// ---- Constants ------------------------------------------------------------

const API_BASE = 'https://discord.com/api/v10';
const BUTTON_LABEL_APPROVE = 'Approve';
const BUTTON_LABEL_EDIT = 'Edit';
const BUTTON_LABEL_REJECT = 'Reject';
const BUTTON_STYLE_PRIMARY = 1;     // blurple — Approve
const BUTTON_STYLE_SECONDARY = 2;   // grey — Edit
const BUTTON_STYLE_DANGER = 4;      // red — Reject

// ---- Auth header ----------------------------------------------------------

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const { DISCORD_BOT_TOKEN } = getDiscordEnv();
  return {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ---- Truncation helpers (exported for tests) -------------------------------

// Discord embed limits: title <= 256, field value <= 1024, description <=
// 4096, and the sum of all embed text <= 6000. These helpers truncate for
// DISPLAY ONLY — the full text always lives in the DB row, and `api/discord.ts`
// reads `row.draftReply` directly (not the embed) when it actually sends.
export const MAX_EMBED_TITLE = 256;
export const MAX_EMBED_FIELD_VALUE = 1024;
export const MAX_EMBED_DESCRIPTION = 4096;

/** Plain-text truncation (no code fences) for short single-line values like the title. */
export function truncatePlain(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

/**
 * Wraps `text` in a code block, truncating its body so the WHOLE block
 * (fences + body + truncation marker) fits within `maxLen`. Fences cost
 * 8 chars (```\n ... \n```); 1 more is reserved for the trailing "…" marker.
 */
export function codeBlock(text: string, maxLen: number, emptyPlaceholder: string): string {
  if (text.length === 0) return emptyPlaceholder;
  const budget = maxLen - 9;
  const needsTrunc = text.length > budget;
  const body = needsTrunc ? `${text.slice(0, budget - 1)}…` : text;
  return `\`\`\`\n${body}\n\`\`\``;
}

// ---- Card build (pure helper, exported for tests) -------------------------

/**
 * Build the Discord message payload (embed + action row) for a triage card.
 * Pure function: no network. The draft reply goes in the embed
 * `description` (4096-char cap) rather than a field (1024-char cap) so it
 * almost never truncates given how short the prompt asks drafts to be; the
 * original email snippet sits alongside it in a field so the reviewer can
 * judge alignment without leaving Discord.
 */
// ---- Card title -----------------------------------------------------------

/**
 * Build an embed title, applying the brand prefix ("[ROI]"/"[DD]") and the
 * shared truncation cap. Used by BOTH card builders and the inline failure
 * cards in api/discord.ts so a failure card keeps the same brand prefix as
 * the card it edits.
 */
export function cardTitle(subject: string | null | undefined, prefix = ''): string {
  const base = subject ?? '(no subject)';
  return truncatePlain(prefix ? `${prefix} ${base}` : base, MAX_EMBED_TITLE);
}

export function buildCardPayload(row: CardRow, cardPrefix = ''): Record<string, unknown> {
  // Show the address an approved reply will actually go to. When Reply-To
  // differs from From (e.g. Web3Forms), this renders as
  // "submitter@example.com (via notify@web3forms.com)" so a reviewer can
  // catch a mis-resolved recipient BEFORE approving. When replyRecipient()
  // refuses (noreply / our own mailbox), render a clear marker instead.
  const recipient = recipientDisplay({ replyTo: row.replyTo, fromAddr: row.fromAddr }, row.fromName);
  const fromLabel = recipient ?? `⚠️ no reply target (from=${row.fromAddr})`;
  const draftBlock = codeBlock(row.draftReply ?? '', MAX_EMBED_DESCRIPTION, '*(no draft)*');
  const snippetBlock = codeBlock(row.bodySnippet ?? '', MAX_EMBED_FIELD_VALUE, '*(no content)*');
  const received = row.receivedAt instanceof Date
    ? row.receivedAt.toISOString()
    : '(unknown time)';

  // Routing field is included only for recycling_help (where routing is
  // non-empty). Omitting it for other categories keeps the card compact.
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Reply to', value: truncatePlain(fromLabel, MAX_EMBED_FIELD_VALUE), inline: false },
    { name: 'Category', value: row.category ?? 'other', inline: true },
    { name: 'Received', value: received, inline: true },
  ];
  if (row.routing) {
    fields.push({ name: 'Routing', value: truncatePlain(row.routing, MAX_EMBED_FIELD_VALUE), inline: false });
  }
  fields.push({ name: 'Original email', value: snippetBlock, inline: false });

  const embed = {
    title: cardTitle(row.subject, cardPrefix),
    description: draftBlock,
    fields,
    color: 0x4f46e5, // indigo, just so cards are visually distinct from chat
  };

  const actionRow = {
    type: 1, // ACTION_ROW
    components: [
      {
        type: 2, // BUTTON
        style: BUTTON_STYLE_PRIMARY,
        label: BUTTON_LABEL_APPROVE,
        custom_id: buildCustomId('approve', row.id),
      },
      {
        type: 2,
        style: BUTTON_STYLE_SECONDARY,
        label: BUTTON_LABEL_EDIT,
        custom_id: buildCustomId('edit', row.id),
      },
      {
        type: 2,
        style: BUTTON_STYLE_DANGER,
        label: BUTTON_LABEL_REJECT,
        custom_id: buildCustomId('reject', row.id),
      },
    ],
  };

  return {
    embeds: [embed],
    components: [actionRow],
  };
}

/**
 * Build the "after-action" payload that REPLACES the card's content:
 * strips the buttons, updates the embed to show outcome.
 */
export function buildResolvedCardPayload(row: CardRow, outcome: 'sent' | 'sent_edited' | 'rejected' | 'send_failed', cardPrefix = ''): Record<string, unknown> {
  const outcomeText = {
    sent: '✅ Sent',
    sent_edited: '✅ Sent (edited)',
    rejected: '⏭️ Skipped',
    send_failed: '⚠️ Send failed — see logs',
  }[outcome];

  const fromLabel = (() => {
    const recipient = recipientDisplay({ replyTo: row.replyTo, fromAddr: row.fromAddr }, row.fromName);
    return recipient ?? `⚠️ no reply target (from=${row.fromAddr})`;
  })();
  // Reserve headroom for the outcome line + separator above the draft so
  // the combined description never exceeds MAX_EMBED_DESCRIPTION.
  const draftBlock = codeBlock(row.draftReply ?? '', MAX_EMBED_DESCRIPTION - 100, '*(no draft)*');
  const snippetBlock = codeBlock(row.bodySnippet ?? '', MAX_EMBED_FIELD_VALUE, '*(no content)*');

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Reply to', value: truncatePlain(fromLabel, MAX_EMBED_FIELD_VALUE), inline: false },
    { name: 'Category', value: row.category ?? 'other', inline: true },
  ];
  if (row.routing) {
    fields.push({ name: 'Routing', value: truncatePlain(row.routing, MAX_EMBED_FIELD_VALUE), inline: false });
  }
  fields.push({ name: 'Original email', value: snippetBlock, inline: false });

  const embed = {
    title: cardTitle(row.subject, cardPrefix),
    description: `${outcomeText}\n\n${draftBlock}`,
    fields,
    color: outcome === 'send_failed' ? 0xb91c1c : 0x16a34a,
  };

  // Components is an EMPTY array — strips the buttons. This is Discord's
  // documented way to remove components on edit.
  return { embeds: [embed], components: [] };
}

// ---- REST calls -----------------------------------------------------------

/**
 * POST a new triage card to the brand's approval channel. The brand drives
 * the channel (via its env config) and the card title prefix ("[ROI] ...").
 * Returns the message id Discord assigns so the caller can save it on the
 * email_queue row for later edits.
 */
export async function postCard(row: CardRow, brand: BrandProfile): Promise<PostedCard> {
  const { discordChannelId } = requireBrandEnv(brand);
  const payload = buildCardPayload(row, brand.cardPrefix);

  const r = await fetch(`${API_BASE}/channels/${discordChannelId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`discord postCard failed: ${r.status} ${text.slice(0, 300)}`);
  }

  const body = (await r.json()) as { id: string; channel_id: string };
  return { messageId: body.id, channelId: body.channel_id };
}

/**
 * POST a plain one-line message (not an embed card) to a channel. Used by
 * the newsletter-subscriber announcement.
 */
export async function postPlainMessage(channelId: string, content: string): Promise<void> {
  const r = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`discord postPlainMessage failed: ${r.status} ${text.slice(0, 300)}`);
  }
}

/**
 * PATCH an existing card (message) with a new payload. Used to flip a
 * card to "Sent" / "Skipped" / "Send failed" and remove its buttons.
 *
 * Guards against an empty `messageId` (SPEC §3.11): an empty id produces
 * a confusing 404 from Discord (`/channels/{cid}/messages/`) that looks
 * like a permissions issue. Fail loudly with a clear error instead.
 */
export async function editCard(channelId: string, messageId: string, payload: Record<string, unknown>): Promise<void> {
  if (!messageId) {
    throw new Error('editCard: messageId is empty — cannot PATCH without a target message id');
  }
  const r = await fetch(`${API_BASE}/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`discord editCard failed: ${r.status} ${text.slice(0, 300)}`);
  }
}

/**
 * Defer the interaction (type 5: DEFERRED_UPDATE_MESSAGE). Used after a
 * button tap so we have time to do SMTP (which can exceed Discord's 3s
 * ACK window) before the original interaction expires. Discord shows the
 * button as "loading" while we work; we follow up with editCard().
 *
 * Per Discord docs: deferred updates give us up to 15 minutes to PATCH
 * the original message via the webhook token. We don't use the webhook
 * token here — we use the bot token via editCard (works as long as the
 * bot has Manage Messages; we required that perm in the GATE).
 */
export async function deferInteraction(interactionId: string, interactionToken: string): Promise<void> {
  void interactionId; // not needed for the response; the token is the auth
  const r = await fetch(
    `https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE }),
    },
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`discord deferInteraction failed: ${r.status} ${text.slice(0, 300)}`);
  }
}

/**
 * Respond to an interaction with a modal (type 9) that lets Adam edit the
 * draft reply before sending. The modal carries the queue id in its
 * custom_id so the MODAL_SUBMIT handler knows which row to update.
 *
 * Modal submit gives the user up to ~45 min; we don't need to defer
 * the original interaction when opening a modal.
 */
export async function openEditModal(interactionId: string, interactionToken: string, row: CardRow): Promise<void> {
  void interactionId;
  // SPEC §3.10: Discord TEXT_INPUT values are capped at 4000 chars.
  // Truncate the prefilled draft to fit; a draft over 4000 chars would
  // otherwise make Discord reject the modal with "This interaction failed."
  const MAX_MODAL_VALUE = 4000;
  const prefill = row.draftReply ?? '';
  const truncated = prefill.length > MAX_MODAL_VALUE
    ? prefill.slice(0, MAX_MODAL_VALUE)
    : prefill;
  if (prefill.length > MAX_MODAL_VALUE) {
    console.warn(
      `[discord] openEditModal: truncating draft (${prefill.length} chars) to ${MAX_MODAL_VALUE}-char cap`,
    );
  }
  const r = await fetch(
    `https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: InteractionResponseType.MODAL,
        data: {
          title: 'Edit reply draft',
          custom_id: buildCustomId('edit_submit', row.id),
          components: [
            {
              type: 1, // ACTION_ROW (modals require a wrapping action row)
              components: [
                {
                  type: 4, // TEXT_INPUT
                  style: 2, // PARAGRAPH
                  label: 'Draft reply (will be sent verbatim)',
                  custom_id: 'draft_text',
                  value: truncated,
                  required: true,
                  max_length: MAX_MODAL_VALUE,
                },
              ],
            },
          ],
        },
      }),
    },
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`discord openEditModal failed: ${r.status} ${text.slice(0, 300)}`);
  }
}

// Re-export InteractionType so callers don't need a second import line.
export { type InteractionType };