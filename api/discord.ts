// api/discord.ts — Discord interactions endpoint.
//
// Receives PINGs (signature verification only) and button-tap interactions
// for the triage cards posted by the poller. Implements Approve / Reject /
// Edit per the action plan, including the Edit modal submit flow.
//
// IMPORTANT: raw body required for signature verification. We export
// `config` with bodyParser:false so Vercel hands us the un-parsed stream.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { sendReply } from '../lib/smtp.js';
import { withImap, markSeen } from '../lib/imap.js';
import { replyRecipient } from '../lib/mail/recipient.js';
import { stripDraftSignoff } from '../lib/mail/signature.js';
import {
  verifyInteraction,
  parseCustomId,
  InteractionType,
  type InteractionType as TInteractionType,
} from '../lib/discord/verify.js';
import {
  editCard,
  deferInteraction,
  buildResolvedCardPayload,
  type CardRow,
} from '../lib/discord/rest.js';
import { getDiscordEnv } from '../types/env.js';

// Disable body parsing — we need the raw body for Ed25519 verification.
export const config = {
  api: {
    bodyParser: false,
  },
};

// ---- Interaction payload types (only the fields we touch) -----------------

type AnyInteraction = {
  id: string;
  token: string;
  channel_id?: string;
  message?: { id: string; channel_id: string };
  data?: { custom_id?: string; components?: unknown };
  type: TInteractionType;
};

// ---- Handler --------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // Read the raw body from the stream. Since bodyParser:false, req is the
  // raw IncomingMessage; `req.body` is unset.
  const rawBody = await readRawBody(req);
  if (rawBody.length === 0) {
    res.status(400).json({ error: 'empty body' });
    return;
  }

  const verified = await verifyInteraction({
    rawBody: rawBody.toString('utf8'),
    signature: String(req.headers['x-signature-ed25519'] ?? ''),
    timestamp: String(req.headers['x-signature-timestamp'] ?? ''),
  });

  if (!verified.ok) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  if (verified.pong) {
    res.status(200).json(verified.pong);
    return;
  }

  const interaction = verified.interaction as AnyInteraction | undefined;
  if (!interaction) {
    // Shouldn't happen — verification parsed it — but be defensive.
    res.status(400).json({ error: 'could not parse interaction' });
    return;
  }

  try {
    await dispatchInteraction(interaction, res);
  } catch (err) {
    const e = err as Error;
    console.error('[discord] dispatch error:', e.message);
    // We've already responded 200 with the initial ACK in most flows, so
    // for those we can't change the response — the user sees a generic
    // "interaction failed" toast. Log loudly so Vercel catches it. For
    // early-throw cases (before ACK), send a 500.
    if (!res.writableEnded) {
      res.status(500).json({ error: 'interaction failed', detail: e.message });
    }
  }
}

// ---- Body reader ----------------------------------------------------------

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- Dispatcher -----------------------------------------------------------

/**
 * Route an authenticated interaction to the right handler based on its
 * type and custom_id. Sends the initial ACK + Discord response on `res`,
 * then performs side effects (DB update, SMTP, IMAP markSeen, card edit).
 *
 * Side-effect flows (Approve/Reject/Edit-submit) defer first so Discord's
 * 3s window doesn't trip while we do SMTP/IMAP.
 */
async function dispatchInteraction(i: AnyInteraction, res: VercelResponse): Promise<void> {
  // PING already handled in the verify step (returned PONG); anything
  // else must be a command/component/modal submit we know about.
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const parsed = parseCustomId(i.data?.custom_id);
    if (!parsed) {
      res.status(400).json({ error: 'malformed custom_id' });
      return;
    }

    if (parsed.action === 'approve') {
      await handleApprove(i, parsed.queueId, res);
      return;
    }
    if (parsed.action === 'reject') {
      await handleReject(i, parsed.queueId, res);
      return;
    }
    if (parsed.action === 'edit') {
      await handleEdit(i, parsed.queueId, res);
      return;
    }

    res.status(400).json({ error: `unknown action: ${parsed.action}` });
    return;
  }

  if (i.type === InteractionType.MODAL_SUBMIT) {
    const parsed = parseCustomId(i.data?.custom_id);
    if (!parsed || parsed.action !== 'edit_submit') {
      res.status(400).json({ error: 'malformed modal submit' });
      return;
    }
    await handleEditSubmit(i, parsed.queueId, res);
    return;
  }

  // Unknown type — acknowledge so Discord doesn't keep retrying.
  res.status(200).json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE as a safestatus
}

// ---- Action handlers ------------------------------------------------------

/**
 * Look up a row by id, returning a CardRow-shaped object (the fields the
 * Discord helpers need) plus the full row for SMTP threading headers.
 */
async function loadRowForCard(queueId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(emailQueue)
    .where(eq(emailQueue.id, queueId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row;
}

function rowToCardRow(row: typeof emailQueue.$inferSelect): CardRow {
  return {
    id: row.id,
    fromAddr: row.fromAddr,
    fromName: row.fromName,
    replyTo: row.replyTo,
    subject: row.subject,
    category: row.category,
    draftReply: row.draftReply,
    bodySnippet: row.bodySnippet,
    receivedAt: row.receivedAt,
    routing: row.routingLabel,
  };
}

async function handleApprove(i: AnyInteraction, queueId: string, res: VercelResponse): Promise<void> {
  // 1. Defer FIRST so Discord's 3s window is satisfied.
  try {
    await deferInteraction(i.id, i.token);
  } catch (err) {
    console.error('[discord] deferInteraction failed:', (err as Error).message);
    // Still ACK Vercel so Discord sees *something*; the button just won't
    // show a loading state. The waitUntil work below still runs.
  }
  res.status(200).json({ type: 6 }); // ACK to Vercel

  // 2. Do the real work AFTER the response. On Vercel serverless, async
  //    work after res.json() is NOT guaranteed to run unless wrapped in
  //    waitUntil() — Vercel freezes the function once the response is sent.
  //    Without this, SMTP/markSeen/DB/card-edit get silently cut off.
  waitUntil(doApproveWork(queueId, i));
}

async function doApproveWork(queueId: string, i: AnyInteraction): Promise<void> {
  const db = getDb();
  const channelId = i.message?.channel_id ?? getDiscordEnv().DISCORD_CHANNEL_ID;

  // Idempotency claim (SPEC §3.4): a double-tap on Approve (or a Discord
  // interaction retry) used to send the reply twice because the buttons
  // stay on the card for several seconds until the waitUntil work finishes
  // editing it. We atomically transition pending|error -> sending and
  // treat "no row updated" as "already handled by a prior tap". This also
  // makes a stuck 'sending' row detectable (it never existed before).
  let claimed: { id: string }[] = [];
  try {
    claimed = await db
      .update(emailQueue)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(and(eq(emailQueue.id, queueId), inArray(emailQueue.status, ['pending', 'error'])))
      .returning({ id: emailQueue.id });
  } catch (err) {
    const e = err as Error;
    console.error(`[discord] approve claim failed for ${queueId}:`, e.message);
    // Can't safely proceed — bail without touching SMTP. Leave the card
    // as-is so Adam can retry.
    return;
  }
  if (claimed.length === 0) {
    console.log(`[discord] approve: row ${queueId} already handled (status no longer pending/error), skipping`);
    return;
  }

  // Re-load the row AFTER claiming so we read the post-claim state.
  const row = await loadRowForCard(queueId);
  if (!row) {
    console.error(`[discord] approve: row ${queueId} vanished after claim`);
    return;
  }
  if (!row.draftReply) {
    console.error(`[discord] approve: row ${queueId} has no draft`);
    // Revert the claim so the row stays retryable.
    await db
      .update(emailQueue)
      .set({ status: 'error', errorDetail: 'approve: no draft to send', updatedAt: new Date() })
      .where(eq(emailQueue.id, queueId));
    return;
  }

  const cardRow = rowToCardRow(row);

  // Send the reply via SMTP.
  try {
    // Resolve the actual reply target. Web3Forms submissions carry
    // From=notify@web3forms.com with Reply-To=<the real submitter>; without
    // this, every approved reply to a form submission would go to the
    // notification bot. replyRecipient returns null when neither From nor
    // Reply-To is a safe reply target (noreply / MAILER-DAEMON / our own
    // mailbox); refuse to send in that case rather than mailing the void.
    const recipient = replyRecipient({ replyTo: row.replyTo, fromAddr: row.fromAddr });
    if (!recipient) {
      const reason = `no safe reply target (from=${row.fromAddr}, replyTo=${row.replyTo ?? 'null'})`;
      console.error(`[discord] approve: ${reason} for ${queueId}`);
      await db
        .update(emailQueue)
        .set({
          status: 'error',
          errorDetail: `approve refused: ${reason}`,
          discordMessageId: i.message?.id ?? row.discordMessageId,
          updatedAt: new Date(),
        })
        .where(eq(emailQueue.id, queueId));
      await editCard(channelId, i.message?.id ?? '', {
        embeds: [{
          title: row.subject ?? '(no subject)',
          description: `⚠️ Not sent: ${reason}`,
          color: 0xb91c1c,
        }],
        components: [],
      });
      return;
    }

    const send = await sendReply({
      to: recipient.to,
      subject: row.subject ?? '(no subject)',
      text: row.draftReply,
      inboundMessageId: row.messageId,
      inboundReferences: row.emailReferences ?? undefined,
    });

    // Mark the inbound read (real email marked read ONLY here, per plan).
    if (row.imapUid !== null) {
      await withImap((client) => markSeen(client, 'INBOX', row.imapUid as number));
    }

    // Update DB row.
    await db
      .update(emailQueue)
      .set({
        status: 'sent',
        discordMessageId: i.message?.id ?? row.discordMessageId,
        updatedAt: new Date(),
      })
      .where(eq(emailQueue.id, queueId));

    // Edit the card to show "Sent" + strip buttons.
    await editCard(channelId, i.message?.id ?? '', buildResolvedCardPayload(cardRow, 'sent'));
    console.log(`[discord] approve sent for ${queueId} (msg ${i.message?.id})`);
    void send;
  } catch (err) {
    const e = err as Error;
    console.error(`[discord] approve failed for ${queueId}:`, e.message);
    // Revert 'sending' -> 'error' so the row stays retryable and the
    // buttons can remain (matching today's "keep the buttons" behaviour).
    await db
      .update(emailQueue)
      .set({
        status: 'error',
        errorDetail: `approve send failed: ${e.message}`,
        discordMessageId: i.message?.id ?? row.discordMessageId,
        updatedAt: new Date(),
      })
      .where(eq(emailQueue.id, queueId));
    // Edit card to "Send failed" and KEEP the buttons so Adam can retry.
    try {
      await editCard(channelId, i.message?.id ?? '', {
        embeds: [{
          title: row.subject ?? '(no subject)',
          description: '⚠️ Send failed — see logs. Buttons remain so you can retry.',
          color: 0xb91c1c,
        }],
        // Intentionally omit `components` — PATCH leaves existing
        // components intact when the field is absent.
      });
    } catch (editErr) {
      console.error('[discord] editCard after failure also failed:', (editErr as Error).message);
    }
  }
}

async function handleReject(i: AnyInteraction, queueId: string, res: VercelResponse): Promise<void> {
  try {
    await deferInteraction(i.id, i.token);
  } catch (err) {
    console.error('[discord] deferInteraction failed:', (err as Error).message);
  }
  res.status(200).json({ type: 6 });

  // Same waitUntil pattern as handleApprove — without it Vercel freezes
  // the function before markSeen/DB update/card edit can complete.
  waitUntil(doRejectWork(queueId, i));
}

async function doRejectWork(queueId: string, i: AnyInteraction): Promise<void> {
  const row = await loadRowForCard(queueId);
  if (!row) {
    console.error(`[discord] reject: row ${queueId} not found`);
    return;
  }

  const db = getDb();
  const channelId = i.message?.channel_id ?? getDiscordEnv().DISCORD_CHANNEL_ID;
  const cardRow = rowToCardRow(row);

  // No SMTP. Mark inbound read (Adam has seen it via the card).
  if (row.imapUid !== null) {
    try {
      await withImap((client) => markSeen(client, 'INBOX', row.imapUid as number));
    } catch (err) {
      console.error('[discord] reject markSeen failed:', (err as Error).message);
    }
  }

  await db
    .update(emailQueue)
    .set({
      status: 'rejected',
      discordMessageId: i.message?.id ?? row.discordMessageId,
      updatedAt: new Date(),
    })
    .where(eq(emailQueue.id, queueId));

  await editCard(channelId, i.message?.id ?? '', buildResolvedCardPayload(cardRow, 'rejected'));
  console.log(`[discord] rejected ${queueId} (msg ${i.message?.id})`);
}

async function handleEdit(i: AnyInteraction, queueId: string, res: VercelResponse): Promise<void> {
  // No defer here — opening a modal IS the response to this interaction.
  // We pass the queue id via the modal's custom_id so the modal submit
  // handler knows which row to update.
  const row = await loadRowForCard(queueId);
  if (!row) {
    res.status(400).json({ error: 'row not found' });
    return;
  }
  const cardRow = rowToCardRow(row);

  // Respond with the modal directly via the InteractionResponse route.
  // discord-interactions' openEditModal POSTs to /interactions/{id}/{token}/callback,
  // but we're already inside the Vercel handler — Discord is awaiting our
  // response on THIS request, not a follow-up. So instead of calling
  // openEditModal (which fires a separate POST), we return the modal
  // payload as the response to this request.
  //
  // SPEC §3.10: Discord TEXT_INPUT values are capped at 4000 chars.
  // Truncate the prefilled draft to fit, with a logged warning when we
  // do — a draft over 4000 chars would otherwise make Discord reject the
  // modal and Adam sees only "This interaction failed."
  const MAX_MODAL_VALUE = 4000;
  const prefill = cardRow.draftReply ?? '';
  const truncated = prefill.length > MAX_MODAL_VALUE
    ? prefill.slice(0, MAX_MODAL_VALUE)
    : prefill;
  if (prefill.length > MAX_MODAL_VALUE) {
    console.warn(
      `[discord] edit modal: truncating draft (${prefill.length} chars) to Discord's ${MAX_MODAL_VALUE}-char TEXT_INPUT cap for row ${queueId}`,
    );
  }
  res.status(200).json({
    type: 9, // MODAL
    data: {
      title: 'Edit reply draft',
      custom_id: `edit_submit:${queueId}`,
      components: [
        {
          type: 1, // ACTION_ROW
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
  });
}

async function handleEditSubmit(i: AnyInteraction, queueId: string, res: VercelResponse): Promise<void> {
  // Modal submit gives us ~45 min, but SMTP can still exceed 3s on cold
  // paths — defer first.
  try {
    await deferInteraction(i.id, i.token);
  } catch (err) {
    console.error('[discord] deferInteraction failed:', (err as Error).message);
  }
  res.status(200).json({ type: 6 });

  // Same waitUntil pattern as Approve — SMTP/markSeen/DB/card-edit must
  // survive past the response or Vercel freezes them out.
  waitUntil(doEditSubmitWork(queueId, i));
}

async function doEditSubmitWork(queueId: string, i: AnyInteraction): Promise<void> {
  const db = getDb();
  const channelId = i.message?.channel_id ?? getDiscordEnv().DISCORD_CHANNEL_ID;

  // Idempotency claim (SPEC §3.4) — same pattern as doApproveWork: a
  // double-tap on the modal submit (or a Discord retry) must not send
  // twice. Atomically transition pending|error -> sending; no-op if the
  // row is no longer in a claimable state.
  let claimed: { id: string }[] = [];
  try {
    claimed = await db
      .update(emailQueue)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(and(eq(emailQueue.id, queueId), inArray(emailQueue.status, ['pending', 'error'])))
      .returning({ id: emailQueue.id });
  } catch (err) {
    const e = err as Error;
    console.error(`[discord] edit_submit claim failed for ${queueId}:`, e.message);
    return;
  }
  if (claimed.length === 0) {
    console.log(`[discord] edit_submit: row ${queueId} already handled, skipping`);
    return;
  }

  const row = await loadRowForCard(queueId);
  if (!row) {
    console.error(`[discord] edit_submit: row ${queueId} vanished after claim`);
    return;
  }

  // Extract the submitted draft text from the modal's components.
  const submitted = extractModalValue(i.data?.components, 'draft_text');
  if (!submitted) {
    console.error(`[discord] edit_submit: no draft_text in modal for ${queueId}`);
    // Revert the claim so the row stays retryable.
    await db
      .update(emailQueue)
      .set({ status: 'error', errorDetail: 'edit_submit: no draft_text in modal', updatedAt: new Date() })
      .where(eq(emailQueue.id, queueId));
    return;
  }

  // Strip the sign-off before storing, exactly as the poller does for a
  // fresh draft (lib/poll/runner.ts): the branded signature block carries
  // the name, and storing the stripped text is what keeps the card, this
  // modal and the email the recipient gets identical. Falls back to the
  // submitted text if stripping would empty the draft.
  const strippedSubmit = stripDraftSignoff(submitted);
  const draft = strippedSubmit.trim() === '' ? submitted : strippedSubmit;

  // Update the row's draft_reply with the edited text.
  await db
    .update(emailQueue)
    .set({ draftReply: draft, updatedAt: new Date() })
    .where(eq(emailQueue.id, queueId));

  const cardRow: CardRow = {
    id: row.id,
    fromAddr: row.fromAddr,
    fromName: row.fromName,
    replyTo: row.replyTo,
    subject: row.subject,
    category: row.category,
    draftReply: draft,
    bodySnippet: row.bodySnippet,
    receivedAt: row.receivedAt,
    routing: row.routingLabel,
  };

  // Send the edited reply.
  try {
    const recipient = replyRecipient({ replyTo: row.replyTo, fromAddr: row.fromAddr });
    if (!recipient) {
      const reason = `no safe reply target (from=${row.fromAddr}, replyTo=${row.replyTo ?? 'null'})`;
      console.error(`[discord] edit_submit: ${reason} for ${queueId}`);
      await db
        .update(emailQueue)
        .set({
          status: 'error',
          errorDetail: `edit_submit refused: ${reason}`,
          updatedAt: new Date(),
        })
        .where(eq(emailQueue.id, queueId));
      await editCard(channelId, i.message?.id ?? '', {
        embeds: [{
          title: row.subject ?? '(no subject)',
          description: `⚠️ Not sent: ${reason}`,
          color: 0xb91c1c,
        }],
        components: [],
      });
      return;
    }

    const send = await sendReply({
      to: recipient.to,
      subject: row.subject ?? '(no subject)',
      text: draft,
      inboundMessageId: row.messageId,
      inboundReferences: row.emailReferences ?? undefined,
    });

    if (row.imapUid !== null) {
      await withImap((client) => markSeen(client, 'INBOX', row.imapUid as number));
    }

    await db
      .update(emailQueue)
      .set({
        status: 'sent',
        discordMessageId: i.message?.id ?? row.discordMessageId,
        updatedAt: new Date(),
      })
      .where(eq(emailQueue.id, queueId));

    // Edit the original card (the one the Edit button was on, NOT a new
    // message). For modal submits, `i.message` is the original card.
    await editCard(channelId, i.message?.id ?? '', buildResolvedCardPayload(cardRow, 'sent_edited'));
    console.log(`[discord] edit_submit sent for ${queueId} (msg ${i.message?.id})`);
    void send;
  } catch (err) {
    const e = err as Error;
    console.error(`[discord] edit_submit send failed for ${queueId}:`, e.message);
    // Revert 'sending' -> 'error' so the row stays retryable.
    await db
      .update(emailQueue)
      .set({
        status: 'error',
        errorDetail: `edit_submit send failed: ${e.message}`,
        updatedAt: new Date(),
      })
      .where(eq(emailQueue.id, queueId));
    await editCard(channelId, i.message?.id ?? '', {
      embeds: [{
        title: row.subject ?? '(no subject)',
        description: '⚠️ Send failed (edited) — see logs.',
        color: 0xb91c1c,
      }],
    });
  }
}

/**
 * Walk the modal submit components array (array of action rows, each
 * containing one text input) and return the value of the text input
 * whose custom_id matches `key`. Returns null if not found.
 */
function extractModalValue(components: unknown, key: string): string | null {
  if (!Array.isArray(components)) return null;
  for (const row of components) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as { components?: unknown };
    if (!Array.isArray(r.components)) continue;
    for (const comp of r.components) {
      if (typeof comp !== 'object' || comp === null) continue;
      const c = comp as { custom_id?: string; value?: string };
      if (c.custom_id === key && typeof c.value === 'string') return c.value;
    }
  }
  return null;
}