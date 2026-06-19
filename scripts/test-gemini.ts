// Sanity-check the Gemini classify+draft pipeline against a set of canned
// emails. Run any of the three canned cases by index, or pass --from /
// --subject / --body for an ad-hoc run.
//
//   npm run test:gemini                          # list available cases
//   npm run test:gemini -- --case 1              # canonical "Please list us"
//   npm run test:gemini -- --case 2              # out-of-scope "do you buy laptops?"
//   npm run test:gemini -- --case 3              # cold SEO spam pitch
//   npm run test:gemini -- --from a@b.com --subject "Hello" --body "..."
//
// Useful for verifying prompt changes (Phase 4 review and Phase 9's
// flash-lite regression check) without standing up the full poller.

import 'dotenv/config';
import { classifyAndDraft, parseClassifyResult } from '../lib/gemini/index.js';

interface CannedCase {
  label: string;
  from: string;
  subject: string;
  body: string;
  expectation: string;
}

const CASES: CannedCase[] = [
  {
    label: 'listing_request: "Please list us"',
    from: 'ron@example.com',
    subject: 'Please list us.',
    body:
      "Hi Adam,\n\n" +
      "I run a small e-waste recycler in Southern Maine offering drop-off and certified data destruction. " +
      "We'd love to be added as a local resource on RecycleOldTech. Our website is kramerecycling.example.\n" +
      "Thanks,\nRon",
    expectation:
      "category=listing_request, should_reply=true, draft points to https://recycleoldtech.com/claims, " +
      'does NOT ask them to email details back, lightly mentions Verified Partner.',
  },
  {
    label: 'out_of_scope: "Do you buy used laptops?"',
    from: 'joe@example.com',
    subject: 'Do you buy old computers?',
    body:
      "Hey, I've got about 200 used laptops from a school district refresh. " +
      'Would you be interested in buying them? Cash deal.',
    expectation:
      "category=out_of_scope, should_reply=true, polite short decline that we DON'T buy/sell, " +
      "no invented service, no over-promising.",
  },
  {
    label: 'spam: cold SEO sales pitch',
    from: 'sales@seo-outsourcer.example',
    subject: 'Boost your RecycleOldTech search rankings',
    body:
      'Hello, I came across your website recycleoldtech.com and noticed it is not ranking ' +
      "well in Google. We can help you get to page 1 for keywords like 'e-waste recycling' " +
      'with our affordable SEO packages. Reply for a free proposal.',
    expectation: 'category=spam, should_reply=false, no draft (empty draft_reply).',
  },
];

function parseArgs(): { caseIndex?: number; from?: string; subject?: string; body?: string } {
  const args = process.argv.slice(2);
  const out: { caseIndex?: number; from?: string; subject?: string; body?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--case' && args[i + 1]) {
      out.caseIndex = Number(args[++i]);
    } else if (a === '--from' && args[i + 1]) {
      out.from = args[++i];
    } else if (a === '--subject' && args[i + 1]) {
      out.subject = args[++i];
    } else if (a === '--body' && args[i + 1]) {
      out.body = args[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: npm run test:gemini -- [--case N] ' +
          '[--from a] [--subject s] [--body b]',
      );
      console.log('Cases:');
      CASES.forEach((c, i) => console.log(`  ${i + 1}: ${c.label}`));
      process.exit(0);
    }
  }
  return out;
}

async function runOne(label: string, from: string, subject: string, body: string, expectation: string): Promise<void> {
  console.log('\n=== ' + label + ' ===');
  console.log(`from:    ${from}`);
  console.log(`subject: ${subject}`);
  console.log(`body:    ${body}`);
  console.log(`expect:  ${expectation}`);
  console.log('---');

  const result = await classifyAndDraft({ from, subject, snippet: body });
  console.log('result:');
  console.log(JSON.stringify(result, null, 2));
  console.log('');
}

async function main() {
  const a = parseArgs();

  // Custom input: override everything.
  if (a.from !== undefined && a.subject !== undefined && a.body !== undefined) {
    await runOne('ad-hoc', a.from, a.subject, a.body, '(caller-supplied)');
    return;
  }

  // Specific case index.
  if (a.caseIndex !== undefined) {
    const c = CASES[a.caseIndex - 1];
    if (!c) {
      console.error(`unknown case index: ${a.caseIndex}. Available: 1..${CASES.length}`);
      process.exit(1);
    }
    await runOne(c.label, c.from, c.subject, c.body, c.expectation);
    return;
  }

  // Default: list cases and a quick parse-coverage check.
  console.log('No --case given. Available cases:');
  CASES.forEach((c, i) => console.log(`  ${i + 1}: ${c.label}`));
  console.log('\nAlso exercise parseClassifyResult with malformed inputs...');
  runParseSelfTests();
  console.log('\nRe-run with --case N to call Gemini with that input.');
}

function runParseSelfTests(): void {
  const samples: Array<[string, string]> = [
    ['clean JSON', '{"category":"spam","should_reply":false,"draft_reply":"","reason":"cold sales"}'],
    ['fenced', '```json\n{"category":"listing_request","should_reply":true,"draft_reply":"hi","reason":"x"}\n```'],
    ['with leading prose', 'Sure, here is the JSON:\n{"category":"other","should_reply":false,"draft_reply":"","reason":"y"}'],
    ['malformed', 'this is not json at all'],
    ['unknown category', '{"category":"newsletter_no_reply","should_reply":false,"draft_reply":"","reason":"z"}'],
    ['should_reply coerced', '{"category":"spam","should_reply":"false-ish","draft_reply":"","reason":"w"}'],
  ];
  for (const [label, raw] of samples) {
    const r = parseClassifyResult(raw);
    console.log(`  ${label.padEnd(22)} -> category=${r.category} should_reply=${r.should_reply} draft="${r.draft_reply.slice(0, 30)}" reason=${r.reason}`);
  }
}

main().catch((err) => {
  console.error('test:gemini crashed:', err);
  process.exit(1);
});