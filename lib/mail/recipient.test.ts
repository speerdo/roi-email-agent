import { describe, it, expect, beforeEach } from 'vitest';
import { resetEnvCache } from '../env.js';
import { replyRecipient, recipientDisplay } from './recipient.js';

// recipient.ts reads EMAIL_USER via getEnv() to detect self-addressed
// mail. Set it for the test process before importing logic that uses it.
process.env.EMAIL_USER = 'hello@recycleoldtech.com';

// getEnv() caches on first call; reset before each test so a stale cache
// from another test file doesn't pin a different EMAIL_USER.
beforeEach(() => {
  resetEnvCache();
});

describe('replyRecipient', () => {
  it('uses Reply-To when present and not our own mailbox (Web3Forms case)', () => {
    const r = replyRecipient({
      replyTo: 'fcrman@aol.com',
      fromAddr: 'notify@web3forms.com',
    });
    expect(r).toEqual({ to: 'fcrman@aol.com', source: 'reply-to' });
  });

  it('falls back to From when Reply-To is absent', () => {
    const r = replyRecipient({ replyTo: null, fromAddr: 'jane@example.com' });
    expect(r).toEqual({ to: 'jane@example.com', source: 'from' });
  });

  it('falls back to From when Reply-To is an empty string', () => {
    const r = replyRecipient({ replyTo: '', fromAddr: 'jane@example.com' });
    expect(r).toEqual({ to: 'jane@example.com', source: 'from' });
  });

  it('returns null when the only candidate is our own mailbox (self-CC / SMTP test)', () => {
    expect(
      replyRecipient({ replyTo: 'hello@recycleoldtech.com', fromAddr: 'hello@recycleoldtech.com' }),
    ).toBeNull();
    expect(
      replyRecipient({ replyTo: null, fromAddr: 'hello@recycleoldtech.com' }),
    ).toBeNull();
  });

  it('refuses MAILER-DAEMON and noreply addresses in either header', () => {
    expect(replyRecipient({ replyTo: null, fromAddr: 'MAILER-DAEMON@mx.privateemail.com' })).toBeNull();
    expect(replyRecipient({ replyTo: null, fromAddr: 'noreply@example.com' })).toBeNull();
    expect(replyRecipient({ replyTo: null, fromAddr: 'no-reply@corp.example' })).toBeNull();
    // Reply-To set to a no-reply address should fall through to From, not void.
    expect(
      replyRecipient({ replyTo: 'noreply@corp.example', fromAddr: 'sales@corp.example' }),
    ).toEqual({ to: 'sales@corp.example', source: 'from' });
  });

  it('uses Reply-To over From even when From is a noreply address', () => {
    const r = replyRecipient({
      replyTo: 'realperson@gmail.com',
      fromAddr: 'noreply@web3forms.com',
    });
    expect(r).toEqual({ to: 'realperson@gmail.com', source: 'reply-to' });
  });

  it('returns null when both headers are empty', () => {
    expect(replyRecipient({ replyTo: '', fromAddr: '' })).toBeNull();
    expect(replyRecipient({ replyTo: null, fromAddr: '' })).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const r = replyRecipient({ replyTo: '  jane@example.com  ', fromAddr: 'notify@x.com' });
    expect(r).toEqual({ to: 'jane@example.com', source: 'reply-to' });
  });
});

describe('recipientDisplay', () => {
  it('shows the resolved recipient alone when From is the reply target', () => {
    expect(recipientDisplay({ replyTo: null, fromAddr: 'jane@example.com' })).toBe(
      'jane@example.com',
    );
  });

  it('annotates the original sender when Reply-To reroutes the reply', () => {
    expect(
      recipientDisplay({ replyTo: 'fcrman@aol.com', fromAddr: 'notify@web3forms.com' }),
    ).toBe('fcrman@aol.com (via notify@web3forms.com)');
  });

  it('returns null when there is no safe reply target', () => {
    expect(
      recipientDisplay({ replyTo: null, fromAddr: 'noreply@example.com' }),
    ).toBeNull();
    expect(
      recipientDisplay({ replyTo: null, fromAddr: 'hello@recycleoldtech.com' }),
    ).toBeNull();
  });

  it('does not annotate when Reply-To equals From (no rerouting)', () => {
    expect(
      recipientDisplay({ replyTo: 'jane@example.com', fromAddr: 'jane@example.com' }),
    ).toBe('jane@example.com');
  });
});