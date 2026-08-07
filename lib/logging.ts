// Per-run summary builder shared by the polling runner (Phase 5) and the
// backlog modes (Phase 8). Counts by category, by skip_reason, errors,
// sync-state cursor movement, duration.

export interface RunError {
  uid?: number;
  messageId?: string;
  stage: string;       // e.g. 'parse', 'prefilter', 'classify', 'smtp', 'db'
  message: string;
}

export interface RunSummary {
  mailbox: string;
  mode: 'incremental' | 'backlog-classify' | 'backlog-draft';
  processed: number;
  byCategory: Record<string, number>;
  bySkipReason: Record<string, number>;
  byStatus: Record<string, number>;
  errors: RunError[];
  /** UIDs successfully flagged \\Seen this run (via the post-batch
   *  markSeenBatch flush). Surfaces in the JSON summary so a reviewer can
   *  confirm the previously-broken mark-read path is now working. */
  markedRead: number;
  /** Count of UIDs below the cursor that the POLL_MAX_AGE_DAYS date
   *  filter excluded from this run (SPEC §3.7). When cron is broken or
   *  the mailbox is quiet for >60 days, real mail lands here with no
   *  row and no way to notice. The Phase 9 error alert surfaces a
   *  non-zero count. -1 means "not checked this run" (e.g. cold start). */
  skippedByAgeCutoff: number;
  /** Filter-drift warnings (SPEC §3.11): a Web3Forms message whose
   *  subject looks like a recycling request did NOT match the recycling
   *  pre-filter — usually means the form's subject template changed and
   *  300+ submissions/yr are about to start hitting Gemini. Each entry
   *  is a short description; the Discord error-alert post surfaces them. */
  filterDriftWarnings: string[];
  lastUidBefore: number | null;
  lastUidAfter: number | null;
  /**
   * Highest UID actually persisted to email_queue so far this run, updated
   * incrementally as each message lands (not just at batch completion). A
   * mid-batch failure (e.g. the IMAP connection dying) throws out of
   * runBatch's loop before it can return — mutating this field as progress
   * happens means the caller can still advance the cursor to whatever was
   * genuinely persisted, instead of losing it back to lastUidBefore.
   */
  highestPersistedUid: number | null;
  nextSince: string | null;       // ISO date for backlog resumption
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

export function newRunSummary(mailbox: string, mode: RunSummary['mode'], lastUidBefore: number | null = null): RunSummary {
  return {
    mailbox,
    mode,
    processed: 0,
    byCategory: {},
    bySkipReason: {},
    byStatus: {},
    errors: [],
    markedRead: 0,
    skippedByAgeCutoff: -1,
    filterDriftWarnings: [],
    lastUidBefore,
    lastUidAfter: lastUidBefore,
    highestPersistedUid: null,
    nextSince: null,
    startedAt: new Date(),
    finishedAt: null,
    durationMs: null,
  };
}

export function bumpCategory(s: RunSummary, category: string | undefined): void {
  if (!category) return;
  s.byCategory[category] = (s.byCategory[category] ?? 0) + 1;
}

export function bumpSkipReason(s: RunSummary, reason: string | undefined): void {
  if (!reason) return;
  s.bySkipReason[reason] = (s.bySkipReason[reason] ?? 0) + 1;
}

export function bumpStatus(s: RunSummary, status: string): void {
  s.byStatus[status] = (s.byStatus[status] ?? 0) + 1;
}

export function recordError(s: RunSummary, err: RunError): void {
  s.errors.push(err);
}

export function finish(s: RunSummary, lastUidAfter: number | null = null, nextSince: string | null = null): void {
  s.finishedAt = new Date();
  s.durationMs = s.finishedAt.getTime() - s.startedAt.getTime();
  if (lastUidAfter !== null) s.lastUidAfter = lastUidAfter;
  if (nextSince !== null) s.nextSince = nextSince;
}

export function toJSON(s: RunSummary): Record<string, unknown> {
  return {
    mailbox: s.mailbox,
    mode: s.mode,
    processed: s.processed,
    byCategory: s.byCategory,
    bySkipReason: s.bySkipReason,
    byStatus: s.byStatus,
    errors: s.errors,
    errorCount: s.errors.length,
    markedRead: s.markedRead,
    skippedByAgeCutoff: s.skippedByAgeCutoff,
    filterDriftWarnings: s.filterDriftWarnings,
    lastUidBefore: s.lastUidBefore,
    lastUidAfter: s.lastUidAfter,
    nextSince: s.nextSince,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    durationMs: s.durationMs,
  };
}

/**
 * One-line Discord-friendly summary for the backlog run or an error
 * alert. Used by Phase 8's `?mode=backlog-classify` summary post and
 * Phase 9's "errors > 0" alert.
 */
export function toDiscordLine(s: RunSummary): string {
  const cat = Object.entries(s.byCategory)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const errs = s.errors.length > 0 ? ` ⚠️ ${s.errors.length} errors` : '';
  return `**${s.mode}** ${s.mailbox} — processed=${s.processed} [${cat}]${errs}`;
}