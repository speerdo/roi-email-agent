// lib/smtp.test.ts
//
// sendReply builds the raw MIME once, sends those bytes over SMTP and then
// IMAP-APPENDs the SAME bytes to the brand's Sent folder. nodemailer's
// transport and imapflow are mocked: nothing here touches a network.
//
// The contract pinned down:
//   - the bytes handed to sendMail({ raw }) are byte-identical to the bytes
//     appended (and carry the explicit Message-ID we return)
//   - the \Sent special-use mailbox wins over name guesses; with no
//     special-use flag the fallback names are tried
//   - no Sent folder => skip, no throw, appendedToSent false
//   - any append failure => no throw, appendedToSent false (email is out)
//   - the brand's OWN credentials are used for the IMAP connection

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mocks (hoisted by vitest before imports) ---------------------------

vi.mock('./env.js', () => ({
  getEnv: () => ({
    EMAIL_IMAP_HOST: 'imap.example.test',
    EMAIL_IMAP_PORT: 993,
    EMAIL_SMTP_HOST: 'smtp.example.test',
    EMAIL_SMTP_PORT: 465,
    EMAIL_USER: 'hello@roi.example',
    EMAIL_PASS: 'roi-pass',
    DISCORD_CHANNEL_ID: '111',
  }),
}));

interface FakeBox {
  path: string;
  specialUse?: string;
}

/** What the next-constructed ImapFlow client LISTs. */
let boxes: FakeBox[] = [];
/** When set, client.connect rejects with this (every attempt). */
let connectError: Error | undefined;
/** When true, client.list never settles (a stalled server). */
let listHangs = false;
/** When set, client.append rejects with this. */
let appendError: Error | undefined;
/** When set, client.append resolves false (server refused). */
let appendRefused = false;
/** Options each ImapFlow was constructed with. */
const imapOptions: Array<{ auth: { user: string; pass: string } }> = [];
const appends: Array<{ path: string; content: Buffer; flags: string[] }> = [];

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(opts: { auth: { user: string; pass: string } }) {
      imapOptions.push(opts);
    }
    connect = vi.fn(() => (connectError ? Promise.reject(connectError) : Promise.resolve()));
    logout = vi.fn(() => Promise.resolve());
    close = vi.fn();
    on = vi.fn();
    list = vi.fn(() => (listHangs ? new Promise(() => {}) : Promise.resolve(boxes)));
    append = vi.fn((path: string, content: Buffer, flags: string[]) => {
      if (appendError) return Promise.reject(appendError);
      if (appendRefused) return Promise.resolve(false);
      appends.push({ path, content, flags });
      return Promise.resolve({ destination: path });
    });
  },
}));

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import { sendReply } from './smtp.js';
import { ROI_BRAND } from './brands/roi.js';
import { DOWNTOWNDRY_BRAND } from './brands/downtowndry.js';

const ORIGINAL_ENV = { ...process.env };

function input(overrides: Partial<Parameters<typeof sendReply>[0]> = {}) {
  return {
    to: 'customer@example.org',
    subject: 'Do you take old laptops?',
    text: 'Yes, we do.\n\nBring it by.',
    inboundMessageId: '<inbound-1@example.org>',
    inboundReferences: '<root@example.org>',
    brand: ROI_BRAND,
    ...overrides,
  };
}

/** The Buffer passed to sendMail({ raw }). */
function sentRaw(): Buffer {
  expect(sendMail).toHaveBeenCalledTimes(1);
  const arg = sendMail.mock.calls[0]![0] as { raw: Buffer; envelope: unknown };
  expect(Buffer.isBuffer(arg.raw)).toBe(true);
  return arg.raw;
}

describe('sendReply -> Sent folder', () => {
  beforeEach(() => {
    boxes = [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Trash' }];
    appendError = undefined;
    appendRefused = false;
    connectError = undefined;
    listHangs = false;
    imapOptions.length = 0;
    appends.length = 0;
    sendMail.mockReset();
    sendMail.mockResolvedValue({ messageId: 'ignored' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('sends raw MIME with an explicit envelope and appends the identical bytes with \\Seen', async () => {
    const res = await sendReply(input());

    const raw = sentRaw();
    const arg = sendMail.mock.calls[0]![0] as { envelope: { from: string; to: string[] } };
    expect(arg.envelope).toEqual({ from: 'hello@roi.example', to: ['customer@example.org'] });

    expect(appends).toHaveLength(1);
    expect(appends[0]!.path).toBe('Sent');
    expect(appends[0]!.flags).toEqual(['\\Seen']);
    // Byte-identical, not just equal-looking.
    expect(Buffer.compare(appends[0]!.content, raw)).toBe(0);

    expect(res.appendedToSent).toBe(true);
  });

  it('puts the threading headers, signature and the returned Message-ID in the raw bytes', async () => {
    const res = await sendReply(input());
    const mime = sentRaw().toString('utf8');

    expect(res.messageId).toMatch(/^<[0-9a-f-]+@roi\.example>$/);
    expect(mime).toContain(`Message-ID: ${res.messageId}`);
    expect(mime).toContain('In-Reply-To: <inbound-1@example.org>');
    expect(mime).toContain('References: <root@example.org> <inbound-1@example.org>');
    expect(mime).toContain('Subject: Re: Do you take old laptops?');
    expect(mime).toContain('To: customer@example.org');
    expect(mime).toMatch(/Content-ID: <[^>]+>/); // inline signature logo
  });

  it('prefers the \\Sent special-use mailbox over a name that merely looks like Sent', async () => {
    boxes = [
      { path: 'INBOX' },
      { path: 'Sent' }, // decoy by name only
      { path: 'Gesendet', specialUse: '\\Sent' },
    ];
    const res = await sendReply(input());
    expect(appends[0]!.path).toBe('Gesendet');
    expect(res.appendedToSent).toBe(true);
  });

  it.each(['Sent', 'INBOX.Sent', 'Sent Items', 'Sent Messages'])(
    'falls back to the common name %s when nothing has the special-use flag',
    async (name) => {
      boxes = [{ path: 'INBOX' }, { path: 'Drafts' }, { path: name }];
      const res = await sendReply(input());
      expect(appends[0]!.path).toBe(name);
      expect(res.appendedToSent).toBe(true);
    },
  );

  it('skips without throwing when the mailbox has no Sent folder', async () => {
    boxes = [{ path: 'INBOX' }, { path: 'Drafts' }, { path: 'Trash' }];
    const res = await sendReply(input());

    expect(sendMail).toHaveBeenCalledTimes(1); // the email still went out
    expect(appends).toHaveLength(0);
    expect(res.appendedToSent).toBe(false);
    expect(res.messageId).toBeDefined();
  });

  it('returns appendedToSent false without throwing when APPEND errors', async () => {
    appendError = new Error('NO [OVERQUOTA] mailbox full');
    const res = await sendReply(input());

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(res.appendedToSent).toBe(false);
    expect(res.messageId).toBeDefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('appendSent failed'));
  });

  it('returns appendedToSent false when the server refuses the APPEND (false result)', async () => {
    appendRefused = true;
    const res = await sendReply(input());
    expect(res.appendedToSent).toBe(false);
  });

  it('returns appendedToSent false without throwing when the IMAP connection fails', async () => {
    vi.useFakeTimers();
    try {
      connectError = new Error('read ECONNRESET');
      const p = sendReply(input());
      await vi.runAllTimersAsync(); // run the connect-retry backoff
      const res = await p;

      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(imapOptions).toHaveLength(2); // one short connection: 1 try + 1 retry
      expect(appends).toHaveLength(0);
      expect(res.appendedToSent).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up with appendedToSent false when LIST/APPEND hangs past the time limit', async () => {
    vi.useFakeTimers();
    try {
      listHangs = true;
      const p = sendReply(input());
      await vi.advanceTimersByTimeAsync(25_000);
      const res = await p;

      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(res.appendedToSent).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('exceeded'));
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends with the brand's OWN credentials, not the shared ROI ones", async () => {
    process.env.DD_EMAIL_USER = 'hello@dd.example';
    process.env.DD_EMAIL_PASS = 'dd-pass';
    process.env.DD_DISCORD_CHANNEL_ID = '222';

    const res = await sendReply(input({ brand: DOWNTOWNDRY_BRAND }));

    expect(imapOptions).toHaveLength(1);
    expect(imapOptions[0]!.auth).toEqual({ user: 'hello@dd.example', pass: 'dd-pass' });
    const arg = sendMail.mock.calls[0]![0] as { envelope: { from: string } };
    expect(arg.envelope.from).toBe('hello@dd.example');
    expect(res.messageId).toMatch(/@dd\.example>$/);
    expect(res.appendedToSent).toBe(true);
  });
});
