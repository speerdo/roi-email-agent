import { describe, it, expect } from 'vitest';
import { bracketMessageId, replyInReplyTo, replyReferences, replySubject } from './headers.js';

describe('bracketMessageId', () => {
  it('wraps a bare id in angle brackets', () => {
    expect(bracketMessageId('abc@example.com')).toBe('<abc@example.com>');
  });
  it('leaves an already-bracketed id alone', () => {
    expect(bracketMessageId('<abc@example.com>')).toBe('<abc@example.com>');
  });
  it('trims surrounding whitespace before checking', () => {
    expect(bracketMessageId('  <abc@example.com>  ')).toBe('<abc@example.com>');
    expect(bracketMessageId('  abc@example.com  ')).toBe('<abc@example.com>');
  });
});

describe('replyInReplyTo', () => {
  it('brackets the inbound Message-ID (the message we are replying to)', () => {
    expect(replyInReplyTo('CABx123@mail.example.com')).toBe('<CABx123@mail.example.com>');
  });
  it('preserves existing angle brackets', () => {
    expect(replyInReplyTo('<CABx123@mail.example.com>')).toBe('<CABx123@mail.example.com>');
  });
  it('returns null when the inbound had no Message-ID', () => {
    expect(replyInReplyTo(null)).toBeNull();
    expect(replyInReplyTo(undefined)).toBeNull();
    expect(replyInReplyTo('')).toBeNull();
    expect(replyInReplyTo('   ')).toBeNull();
  });
});

describe('replyReferences', () => {
  it('appends the inbound Message-ID to the inbound References chain', () => {
    expect(
      replyReferences('child123@example.com', '<parent1@example.com> <parent2@example.com>'),
    ).toBe('<parent1@example.com> <parent2@example.com> <child123@example.com>');
  });
  it('brackets unbracketed IDs in the chain', () => {
    expect(replyReferences('child@example.com', 'parent@example.com')).toBe(
      '<parent@example.com> <child@example.com>',
    );
  });
  it('returns just the inbound Message-ID when there are no prior References', () => {
    expect(replyReferences('only@example.com', null)).toBe('<only@example.com>');
  });
  it('returns null when both are absent', () => {
    expect(replyReferences(null, null)).toBeNull();
    expect(replyReferences('', '')).toBeNull();
  });
  it('dedupes when the inbound References already ended with its own Message-ID', () => {
    // Some clients put the message's own ID in References too.
    expect(
      replyReferences('self@example.com', '<earlier@example.com> <self@example.com>'),
    ).toBe('<earlier@example.com> <self@example.com>');
  });
});

describe('replySubject', () => {
  it('adds Re: prefix to a plain subject', () => {
    expect(replySubject('Recycle Old Tech Contact Form')).toBe('Re: Recycle Old Tech Contact Form');
  });
  it('does NOT double-prefix an already Re: subject (case-insensitive)', () => {
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('re: hello')).toBe('re: hello');
    expect(replySubject('RE: HELLO')).toBe('RE: HELLO');
  });
  it('falls back to (no subject) for empty/undefined input', () => {
    expect(replySubject('')).toBe('Re: (no subject)');
    expect(replySubject(null)).toBe('Re: (no subject)');
    expect(replySubject(undefined)).toBe('Re: (no subject)');
    expect(replySubject('   ')).toBe('Re: (no subject)');
  });
  it('preserves an already-(no subject) subject without double-prefixing', () => {
    expect(replySubject('(no subject)')).toBe('Re: (no subject)');
  });
});
describe('synthesized message_id sentinel', () => {
  // lib/poll/runner.ts stores `no-message-id:<uid>` for messages that
  // arrived without a Message-ID, so the unique constraint still dedupes
  // them. That is an internal DB key, not a real header value — putting it
  // on the wire would emit a fabricated identifier no client can resolve.
  it('is not emitted as In-Reply-To', () => {
    expect(replyInReplyTo('no-message-id:1439')).toBeNull();
  });

  it('is not appended to References', () => {
    expect(replyReferences('no-message-id:1439', undefined)).toBeNull();
  });

  it('does not corrupt an otherwise valid References chain', () => {
    expect(replyReferences('no-message-id:1439', '<a@x.com>')).toBe('<a@x.com>');
  });

  it('still threads on a real Message-ID', () => {
    expect(replyInReplyTo('<real@x.com>')).toBe('<real@x.com>');
  });
});
