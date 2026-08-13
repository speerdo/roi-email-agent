import { describe, it, expect } from 'vitest';
import {
  fingerprintRun,
  decideAlert,
  humanizeDuration,
  REMINDER_INTERVAL_MS,
} from './alerts.js';
import { newRunSummary, recordError, type RunSummary } from './logging.js';

function run(mutate: (s: RunSummary) => void = () => {}): RunSummary {
  const s = newRunSummary('hello@recycleoldtech.com/INBOX', 'incremental', 1483);
  mutate(s);
  return s;
}

const imapDown = () =>
  run((s) => recordError(s, { stage: 'imap', message: 'connect ETIMEDOUT 198.54.122.135:993' }));

describe('fingerprintRun', () => {
  it('returns null for a clean run', () => {
    expect(fingerprintRun(run())).toBeNull();
  });

  it('is stable across runs of the same failure', () => {
    expect(fingerprintRun(imapDown())).toBe(fingerprintRun(imapDown()));
  });

  it('ignores numeric drift within one condition', () => {
    // A different A record or port must not read as a new problem.
    const a = run((s) => recordError(s, { stage: 'imap', message: 'connect ETIMEDOUT 1.2.3.4:993' }));
    const b = run((s) => recordError(s, { stage: 'imap', message: 'connect ETIMEDOUT 9.9.9.9:143' }));
    expect(fingerprintRun(a)).toBe(fingerprintRun(b));
  });

  it('ignores how many messages hit the same failure', () => {
    const one = run((s) => recordError(s, { stage: 'classify', message: 'Gemini 429', uid: 1 }));
    const many = run((s) => {
      for (const uid of [1, 2, 3]) recordError(s, { stage: 'classify', message: 'Gemini 429', uid });
    });
    expect(fingerprintRun(one)).toBe(fingerprintRun(many));
  });

  it('ignores error ordering', () => {
    const a = run((s) => {
      recordError(s, { stage: 'imap', message: 'down' });
      recordError(s, { stage: 'classify', message: 'nope' });
    });
    const b = run((s) => {
      recordError(s, { stage: 'classify', message: 'nope' });
      recordError(s, { stage: 'imap', message: 'down' });
    });
    expect(fingerprintRun(a)).toBe(fingerprintRun(b));
  });

  it('distinguishes genuinely different failures', () => {
    const a = imapDown();
    const b = run((s) => recordError(s, { stage: 'classify', message: 'Gemini 429' }));
    expect(fingerprintRun(a)).not.toBe(fingerprintRun(b));
  });

  it('treats the same message from a different stage as different', () => {
    const a = run((s) => recordError(s, { stage: 'db', message: 'timeout' }));
    const b = run((s) => recordError(s, { stage: 'smtp', message: 'timeout' }));
    expect(fingerprintRun(a)).not.toBe(fingerprintRun(b));
  });

  it('fires on age-cutoff skips and filter drift, not just errors', () => {
    expect(fingerprintRun(run((s) => { s.skippedByAgeCutoff = 3; }))).not.toBeNull();
    expect(fingerprintRun(run((s) => { s.filterDriftWarnings = ['subject changed']; }))).not.toBeNull();
  });

  it('does not re-alert when only the drift count changes', () => {
    const a = run((s) => { s.filterDriftWarnings = ['one']; });
    const b = run((s) => { s.filterDriftWarnings = ['one', 'two']; });
    expect(fingerprintRun(a)).toBe(fingerprintRun(b));
  });

  it('does not treat skippedByAgeCutoff=-1 (not checked) as a condition', () => {
    // -1 means the check never ran; only a positive count is a real skip.
    expect(fingerprintRun(run((s) => { s.skippedByAgeCutoff = -1; }))).toBeNull();
  });
});

describe('decideAlert', () => {
  const now = new Date('2026-08-13T14:00:00Z');
  const fp = 'imap:connect etimedout #.#.#.#:#';

  const priorAt = (lastPosted: string, occurrences = 1, firstSeen = lastPosted) => ({
    fingerprint: fp,
    occurrences,
    firstSeenAt: new Date(firstSeen),
    lastPostedAt: new Date(lastPosted),
  });

  it('stays silent on a clean run with nothing outstanding', () => {
    expect(decideAlert({ fingerprint: null, prior: null, now })).toEqual({ action: 'none' });
  });

  it('posts a brand new condition immediately', () => {
    expect(decideAlert({ fingerprint: fp, prior: null, now })).toEqual({
      action: 'post',
      occurrences: 1,
    });
  });

  it('suppresses an unchanged condition inside the quiet window', () => {
    const d = decideAlert({ fingerprint: fp, prior: priorAt('2026-08-13T13:55:00Z'), now });
    expect(d).toEqual({ action: 'suppress', occurrences: 2 });
  });

  it('reminds once the quiet window has elapsed', () => {
    const d = decideAlert({
      fingerprint: fp,
      prior: priorAt('2026-08-13T12:59:00Z', 6, '2026-08-13T10:40:00Z'),
      now,
    });
    expect(d.action).toBe('remind');
    if (d.action === 'remind') {
      expect(d.occurrences).toBe(7);
      expect(d.firstSeenAt).toEqual(new Date('2026-08-13T10:40:00Z'));
    }
  });

  it('posts immediately when a DIFFERENT failure arrives during an ongoing one', () => {
    // The property that makes suppression safe: a new problem is never
    // masked by the one already being suppressed.
    const d = decideAlert({
      fingerprint: 'classify:gemini #',
      prior: priorAt('2026-08-13T13:59:00Z', 5),
      now,
    });
    expect(d).toEqual({ action: 'post', occurrences: 1 });
  });

  it('announces recovery when a reported condition clears', () => {
    const d = decideAlert({
      fingerprint: null,
      prior: priorAt('2026-08-13T13:50:00Z', 12, '2026-08-13T10:40:00Z'),
      now,
    });
    expect(d.action).toBe('recovered');
    if (d.action === 'recovered') {
      expect(d.occurrences).toBe(12);
      expect(d.firstSeenAt).toEqual(new Date('2026-08-13T10:40:00Z'));
    }
  });

  it('treats an exactly-elapsed window as due', () => {
    const lastPosted = new Date(now.getTime() - REMINDER_INTERVAL_MS);
    const d = decideAlert({
      fingerprint: fp,
      prior: { fingerprint: fp, occurrences: 1, firstSeenAt: lastPosted, lastPostedAt: lastPosted },
      now,
    });
    expect(d.action).toBe('remind');
  });

  it('honors a caller-supplied interval', () => {
    const d = decideAlert({
      fingerprint: fp,
      prior: priorAt('2026-08-13T13:55:00Z'),
      now,
      reminderIntervalMs: 60_000,
    });
    expect(d.action).toBe('remind');
  });

  it('at a 10-minute cron, an hour of outage costs 2 posts instead of 6', () => {
    // Walks the real cadence: first tick posts, the next five suppress,
    // the tick at +60m reminds.
    type Prior = {
      fingerprint: string;
      occurrences: number;
      firstSeenAt: Date;
      lastPostedAt: Date;
    };
    // What api/poll.ts persists after each decision. A free function
    // rather than an inline object literal: assigning to the same `let`
    // that appears in the initializer trips a TS narrowing quirk where
    // the variable reads as `never` inside its own assignment.
    const nextPrior = (
      p: Prior | null,
      at: Date,
      occurrences: number,
      posted: boolean,
    ): Prior => ({
      fingerprint: fp,
      occurrences,
      firstSeenAt: p?.firstSeenAt ?? at,
      lastPostedAt: posted ? at : (p?.lastPostedAt ?? at),
    });

    const start = new Date('2026-08-13T10:40:00Z');
    let prior: Prior | null = null;
    const actions: string[] = [];

    for (let tick = 0; tick <= 6; tick++) {
      const at = new Date(start.getTime() + tick * 10 * 60_000);
      const d = decideAlert({ fingerprint: fp, prior, now: at });
      actions.push(d.action);
      const occurrences = d.action === 'none' || d.action === 'recovered' ? 1 : d.occurrences;
      const posted = d.action === 'post' || d.action === 'remind';
      prior = nextPrior(prior, at, occurrences, posted);
    }

    expect(actions).toEqual([
      'post',
      'suppress',
      'suppress',
      'suppress',
      'suppress',
      'suppress',
      'remind',
    ]);
    expect(prior?.occurrences).toBe(7);
  });
});

describe('humanizeDuration', () => {
  it('renders sub-minute as "just now"', () => {
    expect(humanizeDuration(5_000)).toBe('just now');
  });

  it('renders minutes', () => {
    expect(humanizeDuration(12 * 60_000)).toBe('12m');
  });

  it('renders whole hours without a trailing 0m', () => {
    expect(humanizeDuration(3 * 3_600_000)).toBe('3h');
  });

  it('renders hours and minutes', () => {
    expect(humanizeDuration(3 * 3_600_000 + 20 * 60_000)).toBe('3h 20m');
  });
});
