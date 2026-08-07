// scripts/retry-errors.ts
//
// Re-run classification for status='error' rows whose failure was in the
// classify stage (not in SMTP/IMAP/markSeen — those retry via the Discord
// buttons). Reads errorDetail for "classify error:" prefix, re-calls
// classifyAndDraft, and on success updates the row to pending with the
// fresh category/draft. Leaves non-classify errors alone.
//
//   npm run retry:errors
//
// Useful after a Gemini model retirement (SPEC §3.9) or a transient
// outage that produced a cluster of error rows before the retry-with-
// backoff landed.

import 'dotenv/config';
import { eq, like, and } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { classifyAndDraft } from '../lib/gemini/index.js';
import { resolveCityPage } from '../lib/site/resolveCityPage.js';
import { renderRecyclingHelp } from '../lib/mail/templates/recyclingHelp.js';

async function main() {
  const db = getDb();

  const rows = await db
    .select({
      id: emailQueue.id,
      fromAddr: emailQueue.fromAddr,
      fromName: emailQueue.fromName,
      subject: emailQueue.subject,
      bodySnippet: emailQueue.bodySnippet,
      errorDetail: emailQueue.errorDetail,
      inReplyTo: emailQueue.inReplyTo,
      emailReferences: emailQueue.emailReferences,
    })
    .from(emailQueue)
    .where(and(eq(emailQueue.status, 'error'), like(emailQueue.errorDetail, 'classify error:%')));

  if (rows.length === 0) {
    console.log('No status=error rows with a classify-stage failure. Nothing to retry.');
    return;
  }

  console.log(`Found ${rows.length} classify-error row(s) to retry.\n`);

  let recovered = 0;
  let stillFailing = 0;
  for (const r of rows) {
    try {
      const classify = await classifyAndDraft({
        from: r.fromAddr,
        subject: r.subject ?? '',
        snippet: r.bodySnippet ?? '',
      });

      // recycling_help override — mirrors the runner's logic.
      let draftReply = classify.draft_reply || null;
      let routingLabel: string | null = null;
      let locationHint: unknown = null;
      let resolvedCityUrl: string | null = null;
      if (classify.category === 'recycling_help' && classify.should_reply) {
        const resolved = resolveCityPage(classify.location ?? null);
        draftReply = renderRecyclingHelp({
          firstName: r.fromName ?? null,
          resolved,
          location: classify.location ?? null,
        });
        routingLabel = resolved.routingLabel;
        locationHint = classify.location ?? null;
        resolvedCityUrl = resolved.url;
      }

      await db
        .update(emailQueue)
        .set({
          status: 'pending',
          category: classify.category,
          shouldReply: classify.should_reply,
          draftReply,
          errorDetail: null,
          locationHint: locationHint as never,
          resolvedCityUrl,
          routingLabel,
          updatedAt: new Date(),
        })
        .where(eq(emailQueue.id, r.id));

      console.log(`  recovered: ${r.id} -> ${classify.category}`);
      recovered++;
    } catch (err) {
      const e = err as Error;
      console.error(`  still failing: ${r.id} -> ${e.message}`);
      stillFailing++;
    }
  }

  console.log(`\nDone. recovered=${recovered} stillFailing=${stillFailing}`);
  if (stillFailing > 0) {
    console.log('Still-failing rows remain status=error. Check GEMINI_MODEL / API key.');
  }
}

main().catch((err) => {
  console.error('retry-errors crashed:', err);
  process.exit(1);
});