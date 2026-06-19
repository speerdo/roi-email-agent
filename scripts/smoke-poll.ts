// scripts/smoke-poll.ts
// Local smoke test for the /api/poll handler without needing `vercel dev`
// (which requires Vercel CLI login). Imports the handler directly and
// drives it with a minimal fake VercelRequest/VercelResponse pair.
//
// This DOES hit the live mailbox, Gemini, and Neon — same as the curl
// path the action plan calls for. Use with the real .env.
//
// Usage:
//   tsx scripts/smoke-poll.ts

import 'dotenv/config';
import handler from '../api/poll.js';

interface FakeReq {
  method: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}
interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function makeReqRes(cronSecret: string) {
  const res: FakeRes = { statusCode: 0, body: null, headers: {} };
  const req: FakeReq = {
    method: 'GET',
    query: {},
    headers: { authorization: `Bearer ${cronSecret}` },
    // poll handler doesn't read body; keep it empty.
    body: {},
  };

  // minimal VercelResponse shim — only the methods/fields the handler uses.
  const vercelRes = {
    status(code: number) {
      res.statusCode = code;
      return vercelRes;
    },
    json(payload: unknown) {
      res.body = payload;
      return vercelRes;
    },
    // unused but available for safety
    setHeader: (k: string, v: string) => {
      res.headers[k] = v;
      return vercelRes;
    },
    end: () => vercelRes,
  };

  // VercelRequest is structural; we cast through unknown since the handler
  // only reads headers + query.
  return { req: req as unknown as Parameters<typeof handler>[0], vercelRes: vercelRes as unknown as Parameters<typeof handler>[1], capture: res };
}

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('CRON_SECRET missing from env');
    process.exit(1);
  }

  console.log('[smoke-poll] invoking handler with Bearer auth...');
  const { req, vercelRes, capture } = makeReqRes(secret);
  await handler(req, vercelRes);

  console.log('[smoke-poll] status:', capture.statusCode);
  console.log('[smoke-poll] body:');
  console.log(JSON.stringify(capture.body, null, 2));
}

main().catch((err) => {
  console.error('[smoke-poll] fatal:', err);
  process.exit(1);
});