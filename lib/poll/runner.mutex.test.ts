// lib/poll/runner.mutex.test.ts
//
// Regression test for the IMAP mailbox-lock deadlock (SPEC §1.2).
//
// The bug class: ImapFlow's getMailboxLock is a strict per-connection
// mutex. The old runner called markSeen() inline from inside the fetch
// generator's for-await loop, while the read-only lock was still held —
// a nested write-lock request on the same client that can never be
// granted, deadlocking silently until the 30s socket timeout killed the
// connection. No unit test could catch this because the old runner test
// stubbed IMAP entirely.
//
// This test fakes ImapFlow with a real mutex: a second getMailboxLock
// call while one is held NEVER resolves (just like the real library).
// DB and Gemini are mocked so processMessage can run end-to-end without
// real infrastructure. Then it drives runBatch against a generator that
// yields a couple of messages and a routing policy that says markRead=true.
// The fixed runner returns the markRead UIDs and lets the caller flush
// them AFTER the generator is exhausted; the buggy runner would have
// called markSeen inline and hung forever.
//
// We assert:
//   1. markSeen/messageFlagsAdd is never called while the fetch lock is held.
//   2. runBatch returns within a sane timeout (the buggy code would hang).
//   3. The returned seenUids match what the policy requested.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (hoisted by vitest before imports) ---------------------------

// Mock the DB so processMessage's dedupe + insert + route-update work
// without a real Neon connection. Returns a chainable fake that resolves
// to "no duplicate found" + "insert succeeded with a fake row id".
vi.mock('../db.js', () => {
  // Build a chainable that is BOTH awaitable (resolves to `value`) AND
  // exposes any method (each returning another chainable with the same
  // value). Used to stub the Drizzle query builder without a real Neon
  // connection.
  const chain = (value: unknown) => {
    const target: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve),
      catch: () => Promise.resolve(value),
    };
    return new Proxy(target, {
      get(_t, prop) {
        if (typeof prop === 'string' && (prop === 'then' || prop === 'catch')) {
          return _t[prop];
        }
        // Any property access (method call) returns a function that yields
        // another chainable with the same eventual resolve value.
        return (..._args: unknown[]) => chain(value);
      },
    });
  };

  return {
    getDb: () => ({
      // dedupe: select().from().where().limit() -> []
      select: () => chain([]),
      // insertRow: insert().values().returning() -> [{ id: 'fake-id' }]
      insert: () => chain([{ id: 'fake-id' }]),
      // routing update: update().set().where() -> undefined
      update: () => chain(undefined),
    }),
  };
});

// Mock Gemini so classifyAndDraft returns a canned non-reply-worthy result.
// The routing policy in the test overrides markRead to true regardless.
vi.mock('../gemini/index.js', () => ({
  classifyAndDraft: vi.fn().mockResolvedValue({
    category: 'other',
    should_reply: false,
    draft_reply: '',
    reason: 'mocked',
  }),
}));

// ---- Imports (after mocks are in place) ---------------------------------

import { runBatch, type RoutingContext } from './runner.js';
import type { FetchedMessage } from '../imap.js';
import { newRunSummary } from '../logging.js';

// ---- Fake ImapFlow with a real per-connection lock mutex -------------

class MutexImapFlow {
  public lockHeld = false;
  public nestedAcquireAttempts: { mailbox: string; readOnly: boolean }[] = [];
  public flagCalls: { uids: string; lockHeldAtCall: boolean }[] = [];

  async getMailboxLock(
    mailbox: string,
    opts: { readOnly?: boolean; acquireTimeout?: number } = {},
  ): Promise<{ release: () => void }> {
    if (this.lockHeld) {
      this.nestedAcquireAttempts.push({ mailbox, readOnly: opts.readOnly ?? false });
      const timeout = opts.acquireTimeout ?? Number.POSITIVE_INFINITY;
      return new Promise((_resolve, reject) => {
        const t = setTimeout(
          () =>
            reject(
              new Error(`LockTimeout: nested getMailboxLock on "${mailbox}" after ${timeout}ms`),
            ),
          timeout === Number.POSITIVE_INFINITY ? 60_000 : timeout,
        );
        t.unref?.();
      });
    }
    this.lockHeld = true;
    return {
      release: () => {
        this.lockHeld = false;
      },
    };
  }

  async messageFlagsAdd(uids: string, _flags: string[], _opts: unknown): Promise<void> {
    void _flags;
    this.flagCalls.push({ uids, lockHeldAtCall: this.lockHeld });
  }
}

// ---- Helpers -------------------------------------------------------------

function mkMsg(
  uid: number,
  fromAddr = 'someone@example.com',
  overrides: Partial<FetchedMessage> = {},
): FetchedMessage {
  return {
    uid,
    messageId: `<test-${uid}@example.com>`,
    fromAddr,
    fromName: undefined,
    replyTo: undefined,
    subject: `test ${uid}`,
    text: 'body',
    textSnippet: 'body',
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    inReplyTo: undefined,
    references: undefined,
    contentType: undefined,
    parseError: undefined,
    ...overrides,
  };
}

async function* gen(
  msgs: FetchedMessage[],
  lockState: { held: boolean },
): AsyncIterableIterator<FetchedMessage> {
  for (const m of msgs) {
    if (!lockState.held) {
      throw new Error('fetch lock was NOT held while yielding — test harness is wrong');
    }
    yield m;
  }
}

function markReadPolicy(_ctx: RoutingContext) {
  void _ctx;
  return {
    status: 'skipped' as const,
    markRead: true,
    cardAction: 'skip' as const,
    skipReason: 'test:mark_read',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- The tests ----------------------------------------------------------

describe('runBatch — IMAP lock mutex regression (SPEC §1.2)', () => {
  it('does NOT call markSeen inline (deferred to caller via seenUids)', async () => {
    const fake = new MutexImapFlow();
    const lockState = { held: false };
    const msgs = [mkMsg(101), mkMsg(102), mkMsg(103)];
    const summary = newRunSummary('test/INBOX', 'incremental', 100);

    lockState.held = true;
    const fakeIter = gen(msgs, lockState);
    const fakeClient = fake as unknown as import('imapflow').ImapFlow;
    const result = await runBatch(fakeIter, fakeClient, 'INBOX', markReadPolicy, summary);
    lockState.held = false;

    expect(fake.flagCalls).toEqual([]);
    expect(fake.nestedAcquireAttempts).toEqual([]);
    expect(result.seenUids).toEqual([101, 102, 103]);
    expect(result.highestPersistedUid).toBe(103);
  });

  it('caller-side markSeenBatch flush runs AFTER the fetch lock is released', async () => {
    const fake = new MutexImapFlow();
    const lockState = { held: false };

    lockState.held = true;
    const fakeIter = gen([mkMsg(201), mkMsg(202)], lockState);
    const summary = newRunSummary('test/INBOX', 'incremental', 200);
    const fakeClient = fake as unknown as import('imapflow').ImapFlow;
    const result = await runBatch(fakeIter, fakeClient, 'INBOX', markReadPolicy, summary);
    lockState.held = false;

    expect(result.seenUids).toEqual([201, 202]);
    expect(fake.lockHeld).toBe(false);

    // Caller flush — mimics api/poll.ts markSeenBatch call.
    const lock = await fake.getMailboxLock('INBOX', { readOnly: false, acquireTimeout: 15_000 });
    try {
      await fake.messageFlagsAdd(result.seenUids.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
    expect(fake.nestedAcquireAttempts).toEqual([]);
    expect(fake.flagCalls).toEqual([{ uids: '201,202', lockHeldAtCall: true }]);
    expect(fake.lockHeld).toBe(false);
  });

  it('completes within a sane timeout (the buggy inline-markSeen code would hang)', async () => {
    const fake = new MutexImapFlow();
    const lockState = { held: false };
    const summary = newRunSummary('test/INBOX', 'incremental', 300);
    const fakeClient = fake as unknown as import('imapflow').ImapFlow;

    lockState.held = true;
    const start = Date.now();
    await runBatch(gen([mkMsg(301), mkMsg(302)], lockState), fakeClient, 'INBOX', markReadPolicy, summary);
    lockState.held = false;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(fake.nestedAcquireAttempts).toEqual([]);
  });
});
describe('runBatch — poison-message guard (SPEC §3.5)', () => {
  // A message mailparser cannot handle must not stall the pipeline. The
  // fetch generator yields a degraded message with parseError set (rather
  // than throwing, which would escape the for-await and leave no row), and
  // processMessage writes an error row. The UID must still count as
  // persisted so the cursor advances — otherwise every later poll
  // re-fetches the same message and processes nothing.
  it('writes an error row and still advances the cursor past the bad message', async () => {
    const fake = new MutexImapFlow();
    const lockState = { held: true };
    const summary = newRunSummary('test/INBOX', 'incremental', 400);
    const fakeClient = fake as unknown as import('imapflow').ImapFlow;

    const msgs = [
      mkMsg(401),
      mkMsg(402, 'someone@example.com', { parseError: 'missing source buffer' }),
      mkMsg(403),
    ];
    const result = await runBatch(gen(msgs, lockState), fakeClient, 'INBOX', markReadPolicy, summary);
    lockState.held = false;

    // Cursor moved past the poison message to the last good one.
    expect(result.highestPersistedUid).toBe(403);
    // The failure is recorded rather than swallowed.
    expect(summary.errors.some((e) => e.stage === 'parse' && e.uid === 402)).toBe(true);
    expect(summary.byStatus.error).toBe(1);
    // A message we could not parse is never marked read (nothing was
    // triaged) and never classified.
    expect(result.seenUids).toEqual([401, 403]);
  });
});
