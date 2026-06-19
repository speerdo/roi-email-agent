import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';

type StepResult = { name: string; ok: boolean; detail: string };

const results: StepResult[] = [];
let hadFailure = false;

function record(r: StepResult) {
  results.push(r);
  if (!r.ok) hadFailure = true;
  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${r.name}: ${r.detail}`);
}

function assertEnv(key: string, opts: { allowEmpty?: boolean } = {}): string {
  const v = process.env[key];
  if (v === undefined || (v === '' && !opts.allowEmpty)) {
    throw new Error(`missing env var ${key}`);
  }
  return v;
}

async function checkEnvPresence() {
  const required = [
    'EMAIL_IMAP_HOST', 'EMAIL_IMAP_PORT', 'EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORT',
    'EMAIL_USER', 'EMAIL_PASS',
    'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_CLASSIFY_MODEL',
    'DATABASE_URL', 'CRON_SECRET',
  ];
  const missing: string[] = [];
  for (const k of required) {
    const v = process.env[k];
    if (v === undefined || v === '') missing.push(k);
  }
  // Discord is optional at Phase 0
  const discord = ['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_CHANNEL_ID'];
  const discordMissing: string[] = [];
  for (const k of discord) {
    const v = process.env[k];
    if (v === undefined || v === '') discordMissing.push(k);
  }
  if (missing.length > 0) {
    record({ name: 'env presence', ok: false, detail: `missing: ${missing.join(', ')}` });
  } else {
    let detail = 'all required keys set';
    if (discordMissing.length > 0) detail += ` (discord not yet provisioned: ${discordMissing.join(', ')})`;
    record({ name: 'env presence', ok: true, detail });
  }
}

async function checkNeon() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    record({ name: 'neon', ok: false, detail: 'DATABASE_URL unset, skipped' });
    return;
  }
  try {
    const sql = neon(url);
    const rows = await sql`SELECT 1 AS one`;
    if (rows.length === 1 && (rows[0] as { one?: number }).one === 1) {
      record({ name: 'neon', ok: true, detail: 'SELECT 1 returned 1' });
    } else {
      record({ name: 'neon', ok: false, detail: `unexpected rows: ${JSON.stringify(rows)}` });
    }
  } catch (err) {
    const e = err as Error;
    record({
      name: 'neon',
      ok: false,
      detail: `${e.message} (if this mentions channel_binding/SSL, try stripping "&channel_binding=require" from DATABASE_URL in .env and retry)`,
    });
  }
}

async function checkImap() {
  const host = process.env.EMAIL_IMAP_HOST;
  const port = Number(process.env.EMAIL_IMAP_PORT);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!host || !user || !pass) {
    record({ name: 'imap', ok: false, detail: 'EMAIL_* unset, skipped' });
    return;
  }
  const client = new ImapFlow({
    host,
    port: port || 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      const mailboxes = await client.list();
      const top = (mailboxes || []).slice(0, 10).map((m) => m.path).join(', ');
      record({
        name: 'imap',
        ok: true,
        detail: `INBOX messages=${status.messages} unseen=${status.unseen}; mailboxes: ${top}${(mailboxes || []).length > 10 ? ' ...' : ''}`,
      });
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    const e = err as Error;
    record({ name: 'imap', ok: false, detail: e.message });
    try { await client.logout().catch(() => {}); } catch { /* noop */ }
  }
}

async function checkSmtp() {
  const host = process.env.EMAIL_SMTP_HOST;
  const port = Number(process.env.EMAIL_SMTP_PORT);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!host || !user || !pass) {
    record({ name: 'smtp', ok: false, detail: 'EMAIL_* unset, skipped' });
    return;
  }
  const transport = nodemailer.createTransport({
    host,
    port: port || 465,
    secure: true,
    auth: { user, pass },
  });
  try {
    await transport.verify();
    record({ name: 'smtp', ok: true, detail: 'transport.verify() succeeded' });
  } catch (err) {
    const e = err as Error;
    record({ name: 'smtp', ok: false, detail: e.message });
  } finally {
    transport.close();
  }
}

async function checkGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!apiKey) {
    record({ name: 'gemini', ok: false, detail: 'GEMINI_API_KEY unset, skipped' });
    return;
  }
  try {
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
      model,
      contents: 'Reply with exactly the two characters: OK',
    });
    const text = (typeof res.text === 'string' ? res.text : '').trim();
    record({
      name: 'gemini',
      ok: text.length > 0,
      detail: text.length > 0 ? `model=${model} responded: ${text.slice(0, 60)}` : `model=${model} returned empty text`,
    });
  } catch (err) {
    const e = err as Error;
    record({ name: 'gemini', ok: false, detail: `${e.message} (model=${model})` });
  }
}

async function main() {
  console.log('=== RecycleOldTech email agent — preflight ===\n');
  await checkEnvPresence();
  await checkNeon();
  await checkImap();
  await checkSmtp();
  await checkGemini();

  console.log('\n=== summary ===');
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${r.name}`);
  }
  console.log('');
  if (hadFailure) {
    console.log('preflight FAILED — fix .env and re-run `npm run preflight`');
    process.exit(1);
  }
  console.log('preflight PASSED — ready for Phase 1');
  process.exit(0);
}

main().catch((err) => {
  console.error('preflight crashed:', err);
  process.exit(2);
});