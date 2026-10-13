import { describe, it, expect } from 'vitest';
import {
  parseNewsletterSignup,
  parseNewsletterEmail,
  parseNewsletterPage,
} from './newsletter.js';

describe('parseNewsletterEmail', () => {
  it('parses the Web3Forms `email : x` body line', () => {
    expect(parseNewsletterEmail('name : Reader\nemail : reader@example.com\nmessage : hi')).toBe(
      'reader@example.com',
    );
  });

  it('is case-insensitive on the label and tolerant of spacing', () => {
    expect(parseNewsletterEmail('EMAIL:  Up@Example.COM ')).toBe('up@example.com');
    expect(parseNewsletterEmail('Email   :   a@b.co')).toBe('a@b.co');
  });

  it('returns null when there is no email line or the value is not an address', () => {
    expect(parseNewsletterEmail('name : Reader\nmessage : hi')).toBeNull();
    expect(parseNewsletterEmail('email : not-an-address')).toBeNull();
    expect(parseNewsletterEmail('')).toBeNull();
  });

  it('handles CRLF bodies', () => {
    expect(parseNewsletterEmail('name : X\r\nemail : x@y.zz\r\n')).toBe('x@y.zz');
  });
});

describe('parseNewsletterPage', () => {
  it('extracts the subject suffix after the prefix', () => {
    expect(parseNewsletterPage('New Newsletter Subscriber - Blog Page')).toBe('Blog Page');
    expect(parseNewsletterPage('New Newsletter Subscriber - Homepage')).toBe('Homepage');
  });

  it('accepts a parenthesised suffix', () => {
    expect(parseNewsletterPage('New Newsletter Subscriber (Shop Page)')).toBe('Shop Page');
  });

  it('returns null when the prefix or suffix is missing', () => {
    expect(parseNewsletterPage('Venue Submission')).toBeNull();
    expect(parseNewsletterPage('New Newsletter Subscriber')).toBeNull();
  });
});

describe('parseNewsletterSignup', () => {
  it('returns both fields for a real signup (content-pack N1 shape)', () => {
    expect(
      parseNewsletterSignup('email : reader@example.com', 'New Newsletter Subscriber - Blog Page'),
    ).toEqual({ email: 'reader@example.com', sourcePage: 'Blog Page' });
  });

  it('returns null when the body has no usable address', () => {
    expect(parseNewsletterSignup('no address here', 'New Newsletter Subscriber - Homepage')).toBeNull();
  });
});
