// scripts/test-discord-signature.ts
//
// Generates an Ed25519 keypair, builds a fake Discord PING interaction,
// signs it (timestamp + body) with the private key, and posts the signed
// payload to /api/discord by invoking the handler directly (same pattern
// as smoke-poll.ts — avoids needing vercel login).
//
// Then exercises a fake `approve:<queueId>` interaction against a real
// email_queue row the script inserts first (so the Approve flow can send
// a real SMTP reply if you point it at a recipient you control).
//
// Usage:
//   tsx scripts/test-discord-signature.ts                    # PING only
//   tsx scripts/test-discord-signature.ts --approve <rowId>  # also approve
//   tsx scripts/test-discord-signature.ts --to you@x.com     # full smtp test
//
// IMPORTANT: this script sets DISCORD_PUBLIC_KEY in-process to the
// generated test key, NOT your real one. The handler reads via
// getDiscordEnv() which caches; we call resetEnvCache() first.

import 'dotenv/config';
import crypto, { type KeyObject } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/discord.js';
import { resetEnvCache } from '../types/env.js';

type Anyish = Record<string, unknown>;

interface FakeReq {
  method: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  on: (event: string, cb: (chunk?: Buffer) => void) => void;
}
interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  writableEnded: boolean;
}

function sign(timestamp: string, body: string, privateKey: KeyObject): string {
  // Ed25519 signs over timestamp + body
  const msg = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(body, 'utf8')]);
  return crypto.sign(null, msg, privateKey).toString('hex');
}

function makeReq(bodyBuf: Buffer, publicKeyHex: string, privateKey: KeyObject): FakeReq {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(timestamp, bodyBuf.toString('utf8'), privateKey);
  const req: FakeReq = {
    method: 'POST',
    query: {},
    headers: {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body: {},
    // Stream-like: emit the buffer in one 'data' event then 'end'.
    on: (event, cb) => {
      if (event === 'data') cb(bodyBuf);
      if (event === 'end') cb();
    },
  };
  void publicKeyHex;
  return req;
}

function makeRes(): { res: VercelResponse; capture: FakeRes } {
  const capture: FakeRes = { statusCode: 0, body: null, headers: {}, writableEnded: false };
  const res = {
    status(code: number) { capture.statusCode = code; return res; },
    json(payload: unknown) { capture.body = payload; capture.writableEnded = true; return res; },
    setHeader(k: string, v: string) { capture.headers[k] = v; return res; },
    end() { capture.writableEnded = true; return res; },
    get writableEnded() { return capture.writableEnded; },
  };
  return { res: res as unknown as VercelResponse, capture };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: tsx scripts/test-discord-signature.ts [--ping | --approve <id> | --to <email>]');
    return;
  }

  // Generate an Ed25519 keypair and inject the public key into the env so
  // our signature verifies against what the handler thinks DISCORD_PUBLIC_KEY is.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'der', type: 'spki' },
    privateKeyEncoding: { format: 'der', type: 'pkcs8' },
  });
  // We need raw 32-byte keys for signing + hex-for-env. Re-import + export raw.
  const pubObj = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  const privObj = crypto.createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' });
  const pubRaw = pubObj.export({ format: 'der', type: 'spki' }).subarray(-32); // last 32 bytes are the raw pubkey
  process.env.DISCORD_PUBLIC_KEY = pubRaw.toString('hex');
  resetEnvCache();

  // PING
  if (args.ping || (!args.approve && !args.to)) {
    console.log('\n=== PING test ===');
    const pingBody = JSON.stringify({ type: 1, body: {} });
    const bodyBuf = Buffer.from(pingBody, 'utf8');
    const req = makeReq(bodyBuf, pubRaw.toString('hex'), privObj);
    const { res, capture } = makeRes();
    await handler(req as unknown as VercelRequest, res);
    console.log('status:', capture.statusCode);
    console.log('body:', JSON.stringify(capture.body));
    if (capture.statusCode === 200 && (capture.body as Anyish | null)?.type === 1) {
      console.log('✅ PING -> PONG verified');
    } else {
      console.log('❌ PING test failed');
      process.exit(1);
    }
  }

  if (args.approve) {
    console.log(`\n=== APPROVE test (queueId=${args.approve}) ===`);
    const interaction = {
      type: 3, // MESSAGE_COMPONENT
      id: 'fake-interaction-id',
      token: 'fake-interaction-token',
      channel_id: process.env.DISCORD_CHANNEL_ID,
      message: { id: 'fake-msg-id', channel_id: process.env.DISCORD_CHANNEL_ID },
      data: { custom_id: `approve:${args.approve}` },
    };
    const bodyBuf = Buffer.from(JSON.stringify(interaction), 'utf8');
    const req = makeReq(bodyBuf, pubRaw.toString('hex'), privObj);
    const { res, capture } = makeRes();
    await handler(req as unknown as VercelRequest, res);
    console.log('status:', capture.statusCode);
    console.log('body:', JSON.stringify(capture.body));
    console.log('   (SMTP send happens in the background; check Vercel/console logs and Neon for status=\'sent\')');
  }

  if (args.to && !args.approve) {
    console.log('\n=== --to provided without --approve; --to is only used in the approve flow');
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { ping: boolean; approve: string | null; to: string | null; help: boolean } = {
    ping: false, approve: null, to: null, help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ping') out.ping = true;
    if (args[i] === '--approve' && args[i + 1]) out.approve = args[++i] as string;
    if (args[i] === '--to' && args[i + 1]) out.to = args[++i] as string;
    if (args[i] === '--help' || args[i] === '-h') out.help = true;
  }
  return out;
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});