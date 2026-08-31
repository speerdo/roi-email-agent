// lib/imap.connect.test.ts
//
// Regression test for the IMAP connect retry (withImap / connectWithRetry).
//
// The bug class: mail.privateemail.com intermittently stalls the accept ->
// greeting handoff for ~9s against a ~900ms healthy baseline, and
// occasionally resets the socket instead of completing it. withImap used to
// call client.connect() exactly once, so a single `read ECONNRESET` failed
// the whole 10-minute cron tick and cost two Discord alerts (the error, then
// "recovered" on the next tick) for a blip that a fresh socket would have
// sailed through.
//
// The retry is deliberately scoped to the HANDSHAKE ONLY. The caller's
// callback performs non-idempotent side effects — row inserts, Discord card
// posts, \Seen flagging — so re-running it could double-post. That
// boundary is the most important thing here, and it is what the
// "callback is never retried" case pins down.
//
// ImapFlow and getEnv are mocked so none of this touches a real server.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mocks (hoisted by vitest before imports) ---------------------------

vi.mock('./env.js', () => ({
  getEnv: () => ({
    EMAIL_IMAP_HOST: 'imap.example.test',
    EMAIL_IMAP_PORT: 993,
    EMAIL_USER: 'bot@example.test',
    EMAIL_PASS: 'hunter2',
  }),
}));

/** Scripted behaviors for successive connect() calls. */
type Behavior = 'ok' | 'reject' | 'hang';

const script: Behavior[] = [];
/** One entry per constructed client, in construction order. */
const clients: FakeClient[] = [];

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

vi.mock('imapflow', () => ({
  ImapFlow: class {
    connect = vi.fn(() => {
      const behavior = script.shift() ?? 'ok';
      if (behavior === 'ok') return Promise.resolve();
      if (behavior === 'reject') return Promise.reject(new Error('read ECONNRESET'));
      // 'hang': never settles, like a stalled greeting. The attempt timeout
      // is what must rescue us.
      return new Promise<void>(() => {});
    });
    logout = vi.fn(() => Promise.resolve());
    close = vi.fn();
    on = vi.fn();

    constructor() {
      clients.push(this as unknown as FakeClient);
    }
  },
}));

const { withImap } = await import('./imap.js');

/** Indexed access that fails loudly rather than handing back `undefined`. */
function clientAt(i: number): FakeClient {
  const c = clients[i];
  if (!c) throw new Error(`expected a client at index ${i}, got ${clients.length} total`);
  return c;
}

beforeEach(() => {
  script.length = 0;
  clients.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('withImap connect retry', () => {
  it('does not retry when the first connect succeeds', async () => {
    script.push('ok');
    const fn = vi.fn(async () => 'result');

    await expect(withImap(fn)).resolves.toBe('result');

    expect(clients).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clientAt(0).logout).toHaveBeenCalledTimes(1);
  });

  it('retries on a fresh client after a connect reset, then runs the callback once', async () => {
    script.push('reject', 'ok');
    const fn = vi.fn(async () => 'result');

    await expect(withImap(fn)).resolves.toBe('result');

    // A NEW client per attempt: reusing a reset socket would fail the same way.
    expect(clients).toHaveLength(2);
    // The failed attempt's socket is torn down, not leaked — a half-open
    // connection keeps counting against the server's per-account limit.
    expect(clientAt(0).close).toHaveBeenCalled();
    expect(clientAt(0).logout).not.toHaveBeenCalled();
    // The callback runs exactly once, on the client that actually connected.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(clientAt(1));
  });

  it('gives up after 3 attempts and reports the underlying cause', async () => {
    script.push('reject', 'reject', 'reject');
    const fn = vi.fn();

    await expect(withImap(fn)).rejects.toThrow(
      /imap connect failed after 3 attempts: read ECONNRESET/,
    );

    expect(clients).toHaveLength(3);
    // Every attempt cleans up after itself.
    for (const c of clients) expect(c.close).toHaveBeenCalled();
    // Nothing ran, so nothing to log out of.
    expect(fn).not.toHaveBeenCalled();
  });

  it('NEVER retries the callback — its side effects are not idempotent', async () => {
    script.push('ok');
    const fn = vi.fn(async () => {
      throw new Error('card post failed');
    });

    await expect(withImap(fn)).rejects.toThrow('card post failed');

    // One connect, one callback invocation. A retry here would re-post
    // Discord cards and re-insert rows.
    expect(clients).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
    // Still closed cleanly despite the throw.
    expect(clientAt(0).logout).toHaveBeenCalledTimes(1);
  });

  it('abandons a stalled connect at the attempt timeout and retries', async () => {
    vi.useFakeTimers();
    script.push('hang', 'ok');
    const fn = vi.fn(async () => 'result');

    const pending = withImap(fn);
    // Past the 15s per-attempt ceiling plus the 500ms backoff. Without the
    // timeout this attempt would hang until the function's maxDuration.
    await vi.advanceTimersByTimeAsync(16_000);

    await expect(pending).resolves.toBe('result');
    expect(clients).toHaveLength(2);
    expect(clientAt(0).close).toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
