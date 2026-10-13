import { describe, it, expect } from 'vitest';
import { getBrand, listBrands, DEFAULT_BRAND } from './index.js';
import { DOWNTOWNDRY_BRAND } from './downtowndry.js';
import { buildHtmlBody, textSignature, stripDraftSignoff, signatureAttachment } from '../mail/signature.js';

const DD = DOWNTOWNDRY_BRAND;

describe('DowntownDry brand registry', () => {
  it('resolves by id with the expected identity', () => {
    const brand = getBrand('downtowndry');
    expect(brand.id).toBe('downtowndry');
    expect(brand.domain).toBe('downtowndry.bar');
    expect(brand.fromName).toBe('Downtown Dry');
  });

  it('is listed alongside ROI, without changing the default brand', () => {
    const ids = listBrands().map((b) => b.id).sort();
    expect(ids).toEqual(['downtowndry', 'roi']);
    expect(DEFAULT_BRAND.id).toBe('roi');
  });

  it('throws on an unknown brand id (config bug, not a fallback)', () => {
    expect(() => getBrand('nope')).toThrow(/Unknown brand id: nope/);
  });

  it('exposes the DowntownDry category set', () => {
    expect([...DD.categories].sort()).toEqual(
      [
        'enhanced_listing',
        'feedback',
        'listing_update',
        'other',
        'out_of_scope',
        'partnership',
        'press',
        'spam',
        'venue_submission',
      ].sort(),
    );
  });
});

describe('DowntownDry signature', () => {
  it('plain text is Adam over the bare domain', () => {
    expect(textSignature(DD)).toBe('\n--\nAdam\ndowntowndry.bar');
  });

  it('HTML carries the name, linked domain and DD cid logo', () => {
    const html = buildHtmlBody('Body.', DD);
    expect(html).toContain('>Adam</div>');
    expect(html).toContain('href="https://downtowndry.bar"');
    expect(html).toContain('>downtowndry.bar</a>');
    expect(html).toContain('cid:dd-signature-logo');
    expect(html).not.toContain('recycleoldtech');
  });

  it('uses the DD display size, not ROI’s 300x37', () => {
    const html = buildHtmlBody('Body.', DD);
    expect(html).toMatch(/width="140" height="123"/);
    expect(html).toContain('max-width:140px');
  });

  it('embeds the DD logo asset at the declared aspect ratio', () => {
    const att = signatureAttachment(DD);
    expect(att.cid).toBe('dd-signature-logo');
    expect(att.filename).toBe('downtowndry-logo.png');
    // PNG IHDR: width at byte 16, height at byte 20 (big-endian u32).
    const w = att.content.readUInt32BE(16);
    const h = att.content.readUInt32BE(20);
    expect(w).toBe(300);
    expect(h).toBe(263);
    // Display size must preserve the intrinsic ratio (rounded to 1px).
    expect(Math.round((DD.signature.logoWidth * h) / w)).toBe(DD.signature.logoHeight);
  });
});

describe('DowntownDry sign-off stripping', () => {
  it('drops the DD house sign-off in either order and both spellings', () => {
    expect(stripDraftSignoff('Body.\n\nDowntown Dry / Adam', DD.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\nAdam / DowntownDry.bar', DD.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\nDowntownDry / Adam', DD.signoffPatterns)).toBe('Body.');
  });

  it('drops a bare name or bare brand line', () => {
    expect(stripDraftSignoff('Body.\n\nAdam', DD.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\nDowntown Dry', DD.signoffPatterns)).toBe('Body.');
    expect(stripDraftSignoff('Body.\n\nThe Downtown Dry Team', DD.signoffPatterns)).toBe('Body.');
  });

  it('drops a dangling valediction', () => {
    expect(stripDraftSignoff('Body.\n\nBest regards,', DD.signoffPatterns)).toBe('Body.');
  });

  it('never eats a sign-off-shaped line mid-body', () => {
    const draft = 'Downtown Dry / Adam was here.\n\nEnd.';
    expect(stripDraftSignoff(draft, DD.signoffPatterns)).toBe(draft);
  });

  it('keeps body text that merely ends near a name', () => {
    const draft = 'Reply with the venue details and we will check it.';
    expect(stripDraftSignoff(draft, DD.signoffPatterns)).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// Web3Forms fixtures (docs/brands/DOWNTOWNDRY_PROFILE.md section 4).
//
// The DD newsletter pre-filter rule ("subject contains 'New Newsletter
// Subscriber'") now lives in the REAL per-brand prefilter config
// (DOWNTOWNDRY_BRAND.prefilter.newsletterSubjects), applied through the
// production matcher matchNewsletter(). The fixtures below are asserted
// against it directly — no local rule helper.
// ---------------------------------------------------------------------------

import { matchNewsletter, matchRecyclingRequest } from '../mail/prefilter.js';

interface Fixture {
  id: string;
  from: string;
  subject: string;
  newsletter: boolean;
}

const DD_FORM_SENDER = 'Notifications <notify+kjvf7p@web3forms.com>';
const ROI_FORM_SENDER = 'Notifications <notify@web3forms.com>';

const FIXTURES: Fixture[] = [
  { id: 'F1', from: DD_FORM_SENDER, subject: 'Venue Submission', newsletter: false },
  { id: 'F2', from: DD_FORM_SENDER, subject: 'Listing Update', newsletter: false },
  { id: 'F3', from: DD_FORM_SENDER, subject: 'Website Feedback', newsletter: false },
  { id: 'F4', from: DD_FORM_SENDER, subject: 'Press Inquiry', newsletter: false },
  { id: 'F5', from: DD_FORM_SENDER, subject: 'Partnership Opportunity', newsletter: false },
  { id: 'F6', from: DD_FORM_SENDER, subject: 'Other', newsletter: false },
  // N1 is the newsletter signup: it DOES match and is skipped pre-LLM.
  {
    id: 'N1',
    from: DD_FORM_SENDER,
    subject: 'New Newsletter Subscriber - Blog Page',
    newsletter: true,
  },
  // N4 is ROI's recycling form landing in a DD mailbox: not a DD newsletter.
  { id: 'N4', from: ROI_FORM_SENDER, subject: 'Recycling request from Austin, TX', newsletter: false },
];

describe('DowntownDry fixtures vs the newsletter pre-filter', () => {
  it.each(FIXTURES)('$id ($subject) newsletter=$newsletter', ({ from, subject, newsletter }) => {
    // The production matcher against DD's REAL prefilter config.
    expect(matchNewsletter(subject, from, DD)).toBe(newsletter);
  });

  it('the newsletter rule is subject-only in the DD profile', () => {
    expect(DD.prefilter.newsletterFrom).toBe('');
    expect([...DD.prefilter.newsletterSubjects]).toContain('New Newsletter Subscriber');
  });

  it('DD carries NO automated-form (recycling) pre-filter', () => {
    expect(DD.prefilter.automatedFormSubjects).toHaveLength(0);
    expect(DD.prefilter.automatedFormFrom).toBe('');
    // Even ROI's own form mail must NOT be filtered in a DD mailbox...
    expect(matchRecyclingRequest('Recycling request from Austin, TX', ROI_FORM_SENDER, DD)).toBe(false);
  });

  it('every contact-form fixture falls through to Gemini (no form pre-filter)', () => {
    const contactForms = FIXTURES.filter((f) => f.id.startsWith('F'));
    expect(contactForms).toHaveLength(6);
    for (const f of contactForms) {
      expect(f.newsletter, `${f.id} must reach the LLM`).toBe(false);
    }
  });

  it('never matches on the Web3Forms sender alone', () => {
    // A reply-worthy form email from the Web3Forms sender must not be filtered,
    // even though the newsletter signups come from the same sender.
    for (const f of FIXTURES.filter((x) => x.id.startsWith('F'))) {
      expect(f.from).toContain('web3forms.com');
      expect(matchNewsletter(f.subject, f.from, DD)).toBe(false);
    }
  });
});
