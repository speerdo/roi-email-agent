// An idle poll (nothing above the cached cursor) must not touch Neon.
// Anything uncertain must fall through to the full, DB-backed path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cursor: null as unknown,
  status: { uidNext: 101, uidValidity: 7 } as { uidNext: number; uidValidity: number } | Error,
  getDb: vi.fn(),
  loadSyncState: vi.fn(),
  withImap: vi.fn(),
  writeCursor: vi.fn(),
}));

vi.mock('../lib/env.js', () => ({ getEnv: () => ({ CRON_SECRET: 's3cret' }) }));
vi.mock('../lib/db.js', () => ({ getDb: h.getDb }));
vi.mock('../lib/brands/env.js', () => ({
  getBrandEnv: () => ({ emailUser: 'u', emailPass: 'p', discordChannelId: 'c' }),
}));
vi.mock('../lib/imap.js', () => ({
  fetchSinceUid: vi.fn(),
  markSeenBatch: vi.fn(),
  withImap: h.withImap,
}));
vi.mock('../lib/poll/cursor.js', async (orig) => ({
  ...(await orig<typeof import('../lib/poll/cursor.js')>()),
  readCursor: vi.fn(async () => h.cursor),
  writeCursor: h.writeCursor,
  fetchMailboxStatus: vi.fn(async () => {
    if (h.status instanceof Error) throw h.status;
    return h.status;
  }),
}));
vi.mock('../lib/poll/runner.js', async () => {
  const logging = await import('../lib/logging.js');
  return {
    incrementalPolicy: {},
    loadSyncState: h.loadSyncState,
    saveSyncState: vi.fn(),
    runBatch: vi.fn(async () => ({ seenUids: [] })),
    newRunSummary: logging.newRunSummary,
    finish: logging.finish,
  };
});
vi.mock('../lib/alerts.js', async (orig) => ({
  ...(await orig<typeof import('../lib/alerts.js')>()),
  loadAlertState: vi.fn(async () => {
    h.getDb();
    return null;
  }),
  saveAlertState: vi.fn(),
  clearAlertState: vi.fn(),
}));

import handler from './poll.js';

function call() {
  const res = {
    code: 0,
    body: undefined as unknown,
    status(c: number) { this.code = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  const req = { headers: { authorization: 'Bearer s3cret' }, query: {} };
  return handler(req as never, res as never).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cursor = { lastUid: 100, uidValidity: 7, alertActive: false };
  h.status = { uidNext: 101, uidValidity: 7 };
  h.loadSyncState.mockResolvedValue({ lastUid: 100, existed: true });
  h.withImap.mockResolvedValue(undefined);
});

describe('poll idle shortcut', () => {
  it('no new mail → 200 idle and zero DB access', async () => {
    const res = await call();
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ status: 'idle' });
    expect(h.loadSyncState).not.toHaveBeenCalled();
    expect(h.getDb).not.toHaveBeenCalled();
    expect(h.withImap).not.toHaveBeenCalled();
  });

  it('new UID above the cursor → full path', async () => {
    h.status = { uidNext: 102, uidValidity: 7 };
    await call();
    expect(h.loadSyncState).toHaveBeenCalled();
  });

  it('UIDVALIDITY changed → full path', async () => {
    h.status = { uidNext: 101, uidValidity: 8 };
    await call();
    expect(h.loadSyncState).toHaveBeenCalled();
  });

  it('open alert → full path so recovery can be announced', async () => {
    h.cursor = { lastUid: 100, uidValidity: 7, alertActive: true };
    await call();
    expect(h.loadSyncState).toHaveBeenCalled();
  });

  it('cache miss → full path', async () => {
    h.cursor = null;
    await call();
    expect(h.loadSyncState).toHaveBeenCalled();
  });

  it('STATUS failure → full path', async () => {
    h.status = new Error('imap down');
    await call();
    expect(h.loadSyncState).toHaveBeenCalled();
  });
});
