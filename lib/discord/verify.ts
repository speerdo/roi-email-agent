// lib/discord/verify.ts — Ed25519 signature verification for incoming
// Discord interactions (PINGs and button taps). Discord signs every
// request with the app's Ed25519 private key and sends:
//   X-Signature-Ed25519: <hex signature>
//   X-Signature-Timestamp: <unix seconds>
// We verify signature = Ed25519(timestamp + rawBody, publicKey).
//
// We use discord-interactions' verifyKey() (wraps tweetnacl) rather than
// re-implementing crypto — it's the same library Discord ships samples
// with, so we keep up to date with their verification semantics.
//
// IMPORTANT: signature verification requires the RAW request body bytes,
// not JSON-parsed body. api/discord.ts exports `config` with
// `bodyParser: false` so Vercel passes us the un-parsed stream.

import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { getDiscordEnv } from '../../types/env.js';

export { InteractionType, InteractionResponseType };

export interface VerifyInput {
  rawBody: string | Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
}

export interface VerifyResult {
  ok: boolean;
  /** PONG response body to send when the interaction is a PING. */
  pong?: { type: InteractionResponseType.PONG };
  /** Parsed interaction payload, present whenever ok=true AND not a PING. */
  interaction?: unknown;
}

/**
 * Verify a Discord interaction request's signature and classify it.
 *
 * Returns:
 *   - ok:false      -> caller sends 401 (bad/missing signature)
 *   - ok:true + pong -> caller sends 200 with PONG (type 1)
 *   - ok:true + interaction -> caller processes the interaction payload
 *
 * On signature failure we do not log the body — Vercel logs are visible
 * in their dashboard and we don't want to leak interaction payloads.
 */
export async function verifyInteraction(input: VerifyInput): Promise<VerifyResult> {
  const { DISCORD_PUBLIC_KEY } = getDiscordEnv();
  const signature = input.signature ?? '';
  const timestamp = input.timestamp ?? '';

  if (!signature || !timestamp) {
    return { ok: false };
  }

  const valid = await verifyKey(input.rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
  if (!valid) return { ok: false };

  // Safe to parse now — the body is authentic.
  let interaction: unknown;
  try {
    interaction = JSON.parse(
      typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8'),
    );
  } catch {
    // Authenticated but not JSON — shouldn't happen, but treat as invalid.
    return { ok: false };
  }

  if (isPing(interaction)) {
    return { ok: true, pong: { type: InteractionResponseType.PONG } };
  }

  return { ok: true, interaction };
}

function isPing(i: unknown): i is { type: InteractionType.PING } {
  return (
    typeof i === 'object' && i !== null &&
    (i as { type?: unknown }).type === InteractionType.PING
  );
}

// ---- custom_id parsing ----------------------------------------------------

/**
 * Discord caps custom_id at 100 chars; our scheme is `<action>:<uuid>`,
 * well under that. Parse it back into the action + queue id. Returns
 * null if malformed.
 *
 * Split on the FIRST `:` because UUIDs don't contain colons, but future
 * actions could theoretically (we don't want to mistake a colon in a
 * future action name for the separator).
 */
export function parseCustomId(customId: string | undefined): { action: string; queueId: string } | null {
  if (!customId) return null;
  const idx = customId.indexOf(':');
  if (idx <= 0) return null;
  return {
    action: customId.slice(0, idx),
    queueId: customId.slice(idx + 1),
  };
}

/** Inverse of parseCustomId — build the custom_id for a button. */
export function buildCustomId(action: 'approve' | 'edit' | 'reject' | 'edit_submit', queueId: string): string {
  return `${action}:${queueId}`;
}