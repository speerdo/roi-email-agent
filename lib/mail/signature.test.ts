import { describe, it, expect } from 'vitest';
import {
  DRAFT_SIGNOFF,
  TEXT_SIGNATURE,
  buildHtmlBody,
  draftToHtml,
  stripDraftSignoff,
} from './signature.js';

describe('stripDraftSignoff', () => {
  it('removes the house sign-off and preceding blank lines', () => {
    const draft = 'Hi Justin,\n\nBody paragraph.\n\nRecycleOldTech / Adam';
    expect(stripDraftSignoff(draft)).toBe('Hi Justin,\n\nBody paragraph.');
  });

  it('removes trailing whitespace around the sign-off', () => {
    expect(stripDraftSignoff(`Body.\n\n${DRAFT_SIGNOFF}   \n\n`)).toBe('Body.');
  });

  it('leaves a draft without the sign-off untouched', () => {
    const draft = 'Hi Justin,\n\nBody paragraph.';
    expect(stripDraftSignoff(draft)).toBe(draft);
  });

  it('does not touch a sign-off-shaped line mid-body', () => {
    const draft = `RecycleOldTech / Adam was here.\n\nEnd.`;
    expect(stripDraftSignoff(draft)).toBe(draft);
  });

  it('strips sign-off even when it is the only line', () => {
    expect(stripDraftSignoff(DRAFT_SIGNOFF)).toBe('');
  });
});

describe('draftToHtml', () => {
  it('splits double newlines into real <p> paragraphs', () => {
    const html = draftToHtml('First.\n\nSecond.');
    expect(html).toContain('<p style="margin:0 0 14px 0;">First.</p>');
    expect(html).toContain('<p style="margin:0 0 14px 0;">Second.</p>');
    expect(html).not.toContain('pre');
  });

  it('renders single newlines inside a paragraph as <br>', () => {
    const html = draftToHtml('Line one.\nLine two.');
    expect(html).toContain('Line one.<br />Line two.');
  });

  it('escapes HTML-special characters (model output can inject markup)', () => {
    const html = draftToHtml('<b>bold</b> & "stuff"');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp;');
  });
});

describe('buildHtmlBody', () => {
  it('does NOT rely on <pre>/white-space:pre-wrap (OX webmail strips it and collapses paragraphs)', () => {
    const html = buildHtmlBody('Hi,\n\nPara one.\n\nPara two.');
    expect(html).not.toMatch(/<pre\b/i);
    expect(html).not.toContain('white-space');
    expect(html).toContain('<p ');
  });

  it('includes the signature with name, site link, and inline cid logo', () => {
    const html = buildHtmlBody('Body.');
    expect(html).toContain('Adam Speer');
    expect(html).toContain('https://recycleoldtech.com');
    expect(html).toContain('cid:signature-logo');
    // Correct intrinsic ratio (600x74 asset shown at 300x37) so the
    // image is never squashed/stretched by clients that ignore CSS.
    expect(html).toMatch(/width="300" height="37"/);
  });

  it('keeps the logo above the plain-text-only part out of the draft', () => {
    // The draft itself must not be mutated by the signature build.
    const draft = 'Body.';
    buildHtmlBody(draft);
    expect(draft).toBe('Body.');
  });
});

describe('TEXT_SIGNATURE', () => {
  it('uses the RFC 3676 delimiter and carries name + brand + site', () => {
    expect(TEXT_SIGNATURE).toBe('\n--\nAdam Speer\nRecycleOldTech\nhttps://recycleoldtech.com');
  });
});