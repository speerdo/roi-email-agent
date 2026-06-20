import 'dotenv/config';
import { getDiscordEnv } from '../types/env.js';

const env = getDiscordEnv();
const r = await fetch(
  `https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: 'test message from roi-email-agent (Phase 6 preflight) — reply here if you see it',
    }),
  },
);
console.log('status:', r.status);
const body = await r.text();
console.log('body:', body.slice(0, 500));