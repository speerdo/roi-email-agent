import { describe, it, expect, beforeEach } from 'vitest';
import { resetEnvCache } from '../env.js';
import { incrementalPolicy, type RoutingContext } from './runner.js';

// incrementalPolicy reads SPAM_MARK_READ / OTHER_MARK_READ via getEnv(),
// which asserts the full app env is present. Seed the baseline env vars
// here (the policy only touches the two mark-read flags, but getEnv()
// validates everything) and reset the cache between tests so a stale
// cache from another test file doesn't pin different values.
const baseline = {
  EMAIL_IMAP_HOST: 'mail.privateemail.com',
  EMAIL_IMAP_PORT: '993',
  EMAIL_SMTP_HOST: 'mail.privateemail.com',
  EMAIL_SMTP_PORT: '465',
  EMAIL_USER: 'hello@example.com',
  EMAIL_PASS: 'pw',
  GEMINI_API_KEY: 'k',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_CLASSIFY_MODEL: 'gemini-2.5-flash',
  DATABASE_URL: 'postgres://u:p@h/db',
  CRON_SECRET: 's',
  AUTOMATED_FORM_SUBJECTS: 'Recycling request from',
  AUTOMATED_FORM_FROM: 'notify@web3forms.com',
  NEWSLETTER_FROM: 'example.com',
  DMARC_SUBJECTS: 'Report domain:',
  SPAM_MARK_READ: 'true',
  OTHER_MARK_READ: 'true',
};

beforeEach(() => {
  for (const k of Object.keys(baseline)) delete process.env[k];
  for (const [k, v] of Object.entries(baseline)) process.env[k] = v;
  resetEnvCache();
});

function ctx(partial: Partial<RoutingContext>): RoutingContext {
  return {
    rowId: 'r',
    imapUid: 0,
    category: 'other',
    shouldReply: false,
    draftReply: '',
    fromAddr: 'someone@example.com',
    fromName: undefined,
    replyTo: undefined,
    subject: 'subject',
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    bodySnippet: 'snippet text',
    routing: '',
    ...partial,
  };
}

describe('incrementalPolicy (Phase 5 routing)', () => {
  it('posts a card and leaves unread for reply-worthy non-spam', () => {
    const d = incrementalPolicy(ctx({
      rowId: 'r1',
      imapUid: 10,
      category: 'listing_request',
      shouldReply: true,
      draftReply: 'draft text',
    }));
    expect(d).toEqual({
      status: 'pending',
      markRead: false,
      cardAction: 'post',
    });
  });

  it('skips spam and marks read per SPAM_MARK_READ (default true)', () => {
    const d = incrementalPolicy(ctx({
      rowId: 'r2',
      imapUid: 11,
      category: 'spam',
      shouldReply: true, // even if model says reply, spam never cards
      draftReply: '',
    }));
    expect(d.status).toBe('skipped');
    expect(d.markRead).toBe(true); // SPEC §1.4: spam marked read by default
    expect(d.cardAction).toBe('skip');
    expect(d.skipReason).toBe('spam');
  });

  it('keeps spam unread when SPAM_MARK_READ=false (safety net)', () => {
    process.env.SPAM_MARK_READ = 'false';
    resetEnvCache();
    const d = incrementalPolicy(ctx({
      rowId: 'r2b',
      imapUid: 11,
      category: 'spam',
      shouldReply: true,
      draftReply: '',
    }));
    expect(d.status).toBe('skipped');
    expect(d.markRead).toBe(false);
    expect(d.skipReason).toBe('spam');
    // beforeEach resets env for the next test; no manual restore needed.
  });

  it('skips non-reply categories (out_of_scope, support, other) and marks read per OTHER_MARK_READ', () => {
    for (const category of ['out_of_scope', 'support', 'other'] as const) {
      const d = incrementalPolicy(ctx({
        rowId: 'r3',
        imapUid: 12,
        category,
        shouldReply: false,
        draftReply: '',
      }));
      expect(d.status).toBe('skipped');
      expect(d.markRead).toBe(true); // SPEC §1.4: other marked read by default
      expect(d.cardAction).toBe('skip');
      expect(d.skipReason).toBe(`category:${category}:no_reply`);
    }
  });

  it('keeps non-reply categories unread when OTHER_MARK_READ=false', () => {
    process.env.OTHER_MARK_READ = 'false';
    resetEnvCache();
    const d = incrementalPolicy(ctx({
      rowId: 'r3b',
      imapUid: 12,
      category: 'other',
      shouldReply: false,
      draftReply: '',
    }));
    expect(d.markRead).toBe(false);
    // beforeEach resets env for the next test; no manual restore needed.
  });

  it('does NOT mark read for reply-worthy partner_inquiry/claim', () => {
    // Per plan: real email stays UNREAD until Discord action. The card
    // surfaces it; the human decides; only Approve/Reject marks read.
    for (const category of ['partner_inquiry', 'claim', 'listing_request'] as const) {
      const d = incrementalPolicy(ctx({
        rowId: 'r4',
        imapUid: 13,
        category,
        shouldReply: true,
        draftReply: 'hi',
      }));
      expect(d.markRead).toBe(false);
      expect(d.cardAction).toBe('post');
      expect(d.status).toBe('pending');
    }
  });
});