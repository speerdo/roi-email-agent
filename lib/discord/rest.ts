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
import { buildCustomId } from './verify.js';
import { InteractionResponseType, type InteractionType } from 'discord-interactions';

// ---- Public types ---------------------------------------------------------

/** Subset of email_queue row the card needs. Loosely typed so callers can pass a pick. */
export interface CardRow {
  id: string;
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  category: string | null;
  draftReply: string | null;
  receivedAt: Date | null;
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

// ---- Card build (pure helper, exported for tests) -------------------------

/**
 * Build the Discord message payload (embed + action row) for a triage card.
 * Pure function: no network. The embed shows From / Subject / Category /
 * received_at and the full draft reply in a code block so the reviewer
 * sees EXACTLY what will send.
 *
 * Discord caps embed field values at 1024 chars; draft replies that exceed
 * that are truncated for DISPLAY ONLY, with a marker noting where to find
 * the full text (the DB row). The full draft is what actually sends on
 * Approve — `api/discord.ts` reads `row.draftReply` directly, not this
 * embed field.
 */
export function buildCardPayload(row: CardRow): Record<string, unknown> {
  const fromLabel = row.fromName ? `${row.fromName} <${row.fromAddr}>` : row.fromAddr;
  const draft = row.draftReply && row.draftReply.length > 0 ? row.draftReply : '';
  // Discord caps embed field values at 1024 chars. Our draft block is:
  //   ```\n<truncated>\n```  =  3 + 1 + N + 1 + 3 = N + 8 chars.
  // Add 1 for the trailing truncation marker. So body budget = 1024 - 8 - 1 = 1015.
  const MAX_DRAFT_BODY = 1015;
  const needsTrunc = draft.length > MAX_DRAFT_BODY;
  const body = needsTrunc ? `${draft.slice(0, MAX_DRAFT_BODY - 1)}…` : draft;
  const draftBlock = draft.length > 0
    ? `\`\`\`\n${body}\n\`\`\``
    : '*(no draft)*';
  const received = row.receivedAt instanceof Date
    ? row.receivedAt.toISOString()
    : '(unknown time)';

  const embed = {
    title: row.subject ?? '(no subject)',
    fields: [
      { name: 'From', value: fromLabel, inline: false },
      { name: 'Category', value: row.category ?? 'other', inline: true },
      { name: 'Received', value: received, inline: true },
      { name: 'Draft reply', value: draftBlock, inline: false },
    ],
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
export function buildResolvedCardPayload(row: CardRow, outcome: 'sent' | 'sent_edited' | 'rejected' | 'send_failed'): Record<string, unknown> {
  const outcomeText = {
    sent: '✅ Sent',
    sent_edited: '✅ Sent (edited)',
    rejected: '⏭️ Skipped',
    send_failed: '⚠️ Send failed — see logs',
  }[outcome];

  const fromLabel = row.fromName ? `${row.fromName} <${row.fromAddr}>` : row.fromAddr;
  const draft = row.draftReply && row.draftReply.length > 0 ? row.draftReply : '';
  const MAX_DRAFT_BODY = 1015;
  const needsTrunc = draft.length > MAX_DRAFT_BODY;
  const body = needsTrunc ? `${draft.slice(0, MAX_DRAFT_BODY - 1)}…` : draft;
  const draftBlock = draft.length > 0
    ? `\`\`\`\n${body}\n\`\`\``
    : '*(no draft)*';

  const embed = {
    title: row.subject ?? '(no subject)',
    description: outcomeText,
    fields: [
      { name: 'From', value: fromLabel, inline: false },
      { name: 'Category', value: row.category ?? 'other', inline: true },
      { name: 'Draft reply', value: draftBlock, inline: false },
    ],
    color: outcome === 'send_failed' ? 0xb91c1c : 0x16a34a,
  };

  // Components is an EMPTY array — strips the buttons. This is Discord's
  // documented way to remove components on edit.
  return { embeds: [embed], components: [] };
}

// ---- REST calls -----------------------------------------------------------

/**
 * POST a new triage card to the configured approval channel. Returns the
 * message id Discord assigns so the caller can save it on the
 * email_queue row for later edits.
 */
export async function postCard(row: CardRow): Promise<PostedCard> {
  const { DISCORD_CHANNEL_ID } = getDiscordEnv();
  const payload = buildCardPayload(row);

  const r = await fetch(`${API_BASE}/channels/${DISCORD_CHANNEL_ID}/messages`, {
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
 * PATCH an existing card (message) with a new payload. Used to flip a
 * card to "Sent" / "Skipped" / "Send failed" and remove its buttons.
 */
export async function editCard(channelId: string, messageId: string, payload: Record<string, unknown>): Promise<void> {
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
                  value: row.draftReply ?? '',
                  required: true,
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