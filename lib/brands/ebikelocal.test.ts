import { describe, it, expect } from 'vitest';
import { getBrand, listBrands, DEFAULT_BRAND } from './index.js';
import { EBIKELOCAL_BRAND } from './ebikelocal.js';
import { buildHtmlBody, textSignature, stripDraftSignoff, signatureAttachment } from '../mail/signature.js';
import { matchNewsletter, matchRecyclingRequest } from '../mail/prefilter.js';

const EBL = EBIKELOCAL_BRAND;

describe('eBikeLocal brand registry', () => {
  it('resolves by id with the expected identity', () => {
    const brand = getBrand('ebikelocal');
    expect(brand.id).toBe('ebikelocal');
    expect(brand.domain).toBe('ebikelocal.com');
    expect(brand.fromName).toBe('eBikeLocal');
    expect(brand.envPrefix).toBe('EBL');
    expect(brand.cardPrefix).toBe('[EBL]');
  });

  it('is listed alongside the other brands, without changing the default', () => {
    const ids = listBrands().map((b) => b.id).sort();
    expect(ids).toEqual(['downtowndry', 'ebikelocal', 'roi']);
    expect(DEFAULT_BRAND.id).toBe('roi');
  });

  it('exposes the eBikeLocal category set, all named in the prompt contract', () => {
    const expected = [
      'shop_listing_submission',
      'listing_update',
      'advertising',
      'brand_partnership',
      'press',
      'rider_question',
      'feedback',
      'out_of_scope',
      'spam',
      'other',
    ];
    expect([...EBL.categories].sort()).toEqual([...expected].sort());
    expect(EBL.systemPrompt).toContain(`"category": "${expected.join('|')}"`);
  });
});

describe('eBikeLocal prompt contract', () => {
  it('keeps the no-sign-off and sender_name rules', () => {
    expect(EBL.systemPrompt).toContain('Do NOT sign off.');
    expect(EBL.systemPrompt).toContain('"sender_name"');
    expect(EBL.systemPrompt).toContain('never\ncopy a bot or notification display name');
  });

  it('says what eBikeLocal is not and never invents pricing', () => {
    expect(EBL.systemPrompt).toContain('We do NOT sell eBikes');
    expect(EBL.systemPrompt).toContain('Adam will follow up');
    expect(EBL.systemPrompt).toContain('Do not invent');
  });
});

describe('eBikeLocal signature', () => {
  it('plain text is Adam over the bare domain', () => {
    expect(textSignature(EBL)).toBe('\n--\nAdam\nebikelocal.com');
  });

  it('HTML carries the name, linked domain and EBL cid logo', () => {
    const html = buildHtmlBody('Body.', EBL);
    expect(html).toContain('>Adam</div>');
    expect(html).toContain('href="https://ebikelocal.com"');
    expect(html).toContain('>ebikelocal.com</a>');
    expect(html).toContain('cid:ebl-signature-logo');
    expect(html).not.toContain('recycleoldtech');
    expect(html).not.toContain('downtowndry');
  });

  it('embeds the logo asset at the declared aspect ratio', () => {
    const att = signatureAttachment(EBL);
    expect(att.cid).toBe('ebl-signature-logo');
    expect(att.filename).toBe('ebikelocal-logo.png');
    const w = att.content.readUInt32BE(16);
    const h = att.content.readUInt32BE(20);
    expect(w).toBe(940);
    expect(h).toBe(240);
    expect(Math.round((EBL.signature.logoWidth * h) / w)).toBe(EBL.signature.logoHeight);
  });
});

describe('eBikeLocal sign-off stripping', () => {
  it('drops the house sign-off in either order and both spellings', () => {
    expect(stripDraftSignoff('Body.\n\neBikeLocal / Adam', EBL.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\nAdam / eBikeLocal.com', EBL.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\neBike Local / Adam', EBL.signoffPatterns)).toBe('Body.');
  });

  it('drops a bare name, bare brand line or dangling valediction', () => {
    expect(stripDraftSignoff('Body.\n\nAdam', EBL.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\nThe eBikeLocal Team', EBL.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\nBest regards,', EBL.signoffPatterns)).toBe('Body.');
  });

  it('never eats a sign-off-shaped line mid-body', () => {
    const draft = 'eBikeLocal / Adam was here.\n\nEnd.';
    expect(stripDraftSignoff(draft, EBL.signoffPatterns)).toBe(draft);
  });
});

// Real Web3Forms subjects from ~/Projects/eBikeLocal: the contact form uses a
// FIXED subject (the topic is a body field); the claim API uses
// "Shop claim: <shop>". All must reach Gemini.
describe('eBikeLocal pre-filters', () => {
  const SENDER = 'Notifications <notify@web3forms.com>';
  const PLUS_SENDER = 'Notifications <notify+abc123@web3forms.com>';
  const SUBJECTS = ['eBikeLocal contact form submission', 'Shop claim: Trek Bicycle Store'];

  it.each(SUBJECTS)('"%s" from Web3Forms is not swallowed by any form/newsletter filter', (subject) => {
    for (const from of [SENDER, PLUS_SENDER]) {
      expect(matchNewsletter(subject, from, EBL)).toBe(false);
      expect(matchRecyclingRequest(subject, from, EBL)).toBe(false);
    }
  });

  it('carries no newsletter or automated-form rule (no signup form exists)', () => {
    expect(EBL.prefilter.newsletterFrom).toBe('');
    expect(EBL.prefilter.newsletterSubjects).toHaveLength(0);
    expect(EBL.prefilter.automatedFormSubjects).toHaveLength(0);
    expect(EBL.prefilter.automatedFormFrom).toBe('');
    expect(EBL.newsletterSubscribers).toBe(false);
  });

  it('DMARC subjects match the other brands', () => {
    expect([...EBL.prefilter.dmarcSubjects]).toEqual(['Report domain:', 'Report Domain:']);
  });
});
