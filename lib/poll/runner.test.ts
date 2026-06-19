import { describe, it, expect } from 'vitest';
import { incrementalPolicy } from './runner.js';

describe('incrementalPolicy (Phase 5 routing)', () => {
  it('posts a card and leaves unread for reply-worthy non-spam', () => {
    const d = incrementalPolicy({
      rowId: 'r1',
      imapUid: 10,
      category: 'listing_request',
      shouldReply: true,
      draftReply: 'draft text',
    });
    expect(d).toEqual({
      status: 'pending',
      markRead: false,
      cardAction: 'post',
    });
  });

  it('skips spam without marking read (safety net — stays visible)', () => {
    const d = incrementalPolicy({
      rowId: 'r2',
      imapUid: 11,
      category: 'spam',
      shouldReply: true, // even if model says reply, spam never cards
      draftReply: '',
    });
    expect(d.status).toBe('skipped');
    expect(d.markRead).toBe(false);
    expect(d.cardAction).toBe('skip');
    expect(d.skipReason).toBe('spam');
  });

  it('skips non-reply categories (out_of_scope, support, other) with no read, no card', () => {
    for (const category of ['out_of_scope', 'support', 'other'] as const) {
      const d = incrementalPolicy({
        rowId: 'r3',
        imapUid: 12,
        category,
        shouldReply: false,
        draftReply: '',
      });
      expect(d.status).toBe('skipped');
      expect(d.markRead).toBe(false);
      expect(d.cardAction).toBe('skip');
      expect(d.skipReason).toBe(`category:${category}:no_reply`);
    }
  });

  it('does NOT mark read for reply-worthy partner_inquiry/claim', () => {
    // Per plan: real email stays UNREAD until Discord action. The card
    // surfaces it; the human decides; only Approve/Reject marks read.
    for (const category of ['partner_inquiry', 'claim', 'listing_request'] as const) {
      const d = incrementalPolicy({
        rowId: 'r4',
        imapUid: 13,
        category,
        shouldReply: true,
        draftReply: 'hi',
      });
      expect(d.markRead).toBe(false);
      expect(d.cardAction).toBe('post');
      expect(d.status).toBe('pending');
    }
  });
});