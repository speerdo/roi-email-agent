import { describe, it, expect } from 'vitest';
import { parseCustomId, buildCustomId } from './verify.js';

describe('parseCustomId / buildCustomId', () => {
  it('builds and parses approve', () => {
    const id = buildCustomId('approve', '550e8400-e29b-41d4-a716-446655440000');
    expect(id).toBe('approve:550e8400-e29b-41d4-a716-446655440000');
    expect(parseCustomId(id)).toEqual({
      action: 'approve',
      queueId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('splits on the FIRST colon only', () => {
    // uuid has no colon, but this guards against future action names like
    // 'edit:submit' accidentally splitting twice.
    expect(parseCustomId('edit:550e8400-e29b-41d4-a716-446655440000')).toEqual({
      action: 'edit',
      queueId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('returns null on malformed input', () => {
    expect(parseCustomId(undefined)).toBeNull();
    expect(parseCustomId('')).toBeNull();
    expect(parseCustomId('no_colon_here')).toBeNull();
    expect(parseCustomId(':leading_colon')).toBeNull();
  });

  it('stays well under Discord 100-char custom_id limit', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    for (const action of ['approve', 'edit', 'reject', 'edit_submit'] as const) {
      const id = buildCustomId(action, uuid);
      expect(id.length).toBeLessThan(100);
    }
  });
});