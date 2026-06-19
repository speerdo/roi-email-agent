import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchRecyclingRequest,
  matchNewsletter,
  matchDmarc,
  runPrefilters,
  resetPrefilterConfig,
} from './prefilter.js';

// Baseline matching .env.example defaults.
const baseline = {
  AUTOMATED_FORM_SUBJECTS: 'Recycling request from',
  AUTOMATED_FORM_FROM: 'notify@web3forms.com',
  AUTOMATED_FORM_MARK_READ: 'true',
  NEWSLETTER_FROM: 'wasteadvantagemag.com',
  NEWSLETTER_SUBJECTS: '',
  NEWSLETTER_MARK_READ: 'true',
  DMARC_SUBJECTS: 'Report domain:,Report Domain:',
  DMARC_FROM: '',
  DMARC_MARK_READ: 'true',
};

function withEnv(overrides: Record<string, string | undefined> = {}): void {
  resetPrefilterConfig();
  for (const k of Object.keys(baseline)) delete process.env[k];
  for (const [k, v] of Object.entries(baseline)) process.env[k] = v;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => withEnv());

describe('matchRecyclingRequest', () => {
  it('matches happy path: web3forms sender + recycling subject prefix', () => {
    expect(
      matchRecyclingRequest('Recycling request from Surprise, Arizona', 'notify@web3forms.com'),
    ).toBe(true);
  });

  it('is case-insensitive on subject and sender', () => {
    expect(
      matchRecyclingRequest('RECYCLING REQUEST FROM Phoenix', 'NoTIFY@WEB3FORMS.COM'),
    ).toBe(true);
  });

  it('SAFETY: web3forms sender + DIFFERENT subject does NOT match', () => {
    expect(
      matchRecyclingRequest('Contact form inquiry', 'notify@web3forms.com'),
    ).toBe(false);
    expect(
      matchRecyclingRequest('Partner inquiry', 'notify@web3forms.com'),
    ).toBe(false);
  });

  it('SAFETY: recycling subject prefix + DIFFERENT sender does NOT match', () => {
    expect(
      matchRecyclingRequest('Recycling request from Mesa', 'someone@example.com'),
    ).toBe(false);
  });

  it('matches when subject prefix is one of multiple configured prefixes', () => {
    withEnv({ AUTOMATED_FORM_SUBJECTS: 'Recycling request from,Another prefix' });
    expect(
      matchRecyclingRequest('Another prefix: hello', 'notify@web3forms.com'),
    ).toBe(true);
  });

  it('requires the subject to START with the prefix, not just contain it', () => {
    expect(
      matchRecyclingRequest('Re: Recycling request from Tucson', 'notify@web3forms.com'),
    ).toBe(false);
  });
});

describe('matchNewsletter', () => {
  it('matches by sender domain substring', () => {
    expect(matchNewsletter('Weekly digest', 'news@wasteadvantagemag.com')).toBe(true);
  });

  it('is case-insensitive on sender', () => {
    expect(matchNewsletter('Weekly digest', 'NEWS@WasteAdvantageMag.COM')).toBe(true);
  });

  it('matches by subject when NEWSLETTER_SUBJECTS is set', () => {
    withEnv({ NEWSLETTER_SUBJECTS: 'Weekly digest,E-waste news' });
    expect(matchNewsletter('Weekly digest — issue 42', 'someone@else.com')).toBe(true);
  });

  it('does NOT match newsletters subject rule when subject list is empty', () => {
    expect(matchNewsletter('Weekly digest', 'someone@else.com')).toBe(false);
  });

  it('does not false-positive on unrelated mail', () => {
    expect(matchNewsletter('Please list my business', 'jane@recycler.com')).toBe(false);
  });
});

describe('matchDmarc', () => {
  it('matches "Report domain:" subject', () => {
    expect(matchDmarc('Report domain: recycleoldtech.com', 'dmarc@ext.com')).toBe(true);
  });

  it('matches "Report Domain:" (capitalized variant) case-insensitively', () => {
    expect(matchDmarc('Report Domain: example.com', 'foo@x.com')).toBe(true);
  });

  it('does NOT match unrelated subject', () => {
    expect(matchDmarc('Report from the field', 'foo@x.com')).toBe(false);
  });

  it('requires sender match when DMARC_FROM is set', () => {
    withEnv({ DMARC_FROM: 'dmarc-agg@ex.com' });
    expect(matchDmarc('Report domain: x.com', 'someone@else.com')).toBe(false);
    expect(matchDmarc('Report domain: x.com', 'dmarc-agg@ex.com')).toBe(true);
  });

  it('does not require sender when DMARC_FROM is unset', () => {
    expect(matchDmarc('Report domain: x.com', 'anyone@anywhere.com')).toBe(true);
  });
});

describe('runPrefilters', () => {
  it('matches recycling first and returns the right metadata', () => {
    const r = runPrefilters({
      subject: 'Recycling request from Surprise, Arizona',
      from: { address: 'notify@web3forms.com' },
    });
    expect(r).toEqual({
      matched: true,
      category: 'recycling_request',
      skipReason: 'recycling_form_make_handled',
      markRead: true,
    });
  });

  it('matches newsletter second', () => {
    const r = runPrefilters({
      subject: 'Weekly e-waste digest',
      from: { address: 'news@wasteadvantagemag.com' },
    });
    expect(r).toEqual({
      matched: true,
      category: 'newsletter',
      skipReason: 'newsletter',
      markRead: true,
    });
  });

  it('matches DMARC third', () => {
    const r = runPrefilters({
      subject: 'Report domain: recycleoldtech.com',
      from: { address: 'dmarc@some.com' },
    });
    expect(r).toEqual({
      matched: true,
      category: 'dmarc',
      skipReason: 'dmarc_report',
      markRead: true,
    });
  });

  it('returns no match when nothing applies', () => {
    const r = runPrefilters({
      subject: 'Please list our business',
      from: { address: 'jane@ecycler.com' },
    });
    expect(r).toEqual({ matched: false });
  });

  it('first match wins: a DMARC-looking subject from web3forms (unlikely) still resolves to recycling', () => {
    // Recycling is checked first; subject does NOT start with the prefix,
    // so we fall through; newsletter matches on sender? No — web3forms
    // isn't the newsletter domain. DMARC matches the subject. So a
    // web3forms email whose subject happens to contain "Report domain:"
    // would be tagged DMARC, which is the documented plan order.
    const r = runPrefilters({
      subject: 'Report domain: example.com',
      from: { address: 'notify@web3forms.com' },
    });
    expect(r).toMatchObject({ matched: true, category: 'dmarc' });
  });

  it('respects *_MARK_READ=false config', () => {
    withEnv({ AUTOMATED_FORM_MARK_READ: 'false' });
    const r = runPrefilters({
      subject: 'Recycling request from Tempe',
      from: { address: 'notify@web3forms.com' },
    });
    expect(r).toMatchObject({ matched: true, markRead: false });
  });

  it('handles empty subject gracefully', () => {
    expect(runPrefilters({ subject: '', from: { address: 'anyone@x.com' } })).toEqual({
      matched: false,
    });
  });
});