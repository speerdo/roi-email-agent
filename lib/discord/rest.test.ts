import { describe, it, expect } from 'vitest';
import { buildCardPayload, buildResolvedCardPayload, type CardRow } from './rest.js';

interface CardPayload {
  embeds: Array<{
    title: string;
    description?: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
  }>;
  components: Array<{
    type: number;
    components: Array<{ type: number; label: string; custom_id: string; style: number }>;
  }>;
}

function payload(p: ReturnType<typeof buildCardPayload>): CardPayload {
  return p as unknown as CardPayload;
}

function sampleRow(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    fromAddr: 'someone@example.com',
    fromName: 'Someone',
    subject: 'Please list us',
    category: 'listing_request',
    draftReply: 'Hi, head to https://recycleoldtech.com/claims to submit.',
    receivedAt: new Date('2026-06-20T12:00:00Z'),
    ...overrides,
  };
}

describe('buildCardPayload', () => {
  it('produces an embed + one action row with 3 buttons (Approve/Edit/Reject)', () => {
    const p = payload(buildCardPayload(sampleRow()));
    expect(Array.isArray(p.embeds)).toBe(true);
    expect(p.embeds).toHaveLength(1);
    expect(Array.isArray(p.components)).toBe(true);
    expect(p.components).toHaveLength(1);
    const row = p.components[0]!;
    expect(row.type).toBe(1); // ACTION_ROW
    expect(row.components).toHaveLength(3);
    expect(row.components.map((b) => b.label)).toEqual(['Approve', 'Edit', 'Reject']);
    row.components.forEach((b) => expect(b.type).toBe(2)); // BUTTON
    row.components.forEach((b) => {
      expect(b.custom_id).toMatch(/^(approve|edit|reject):550e8400-e29b-41d4-a716-446655440000$/);
    });
  });

  it('embed includes From with name, Subject, Category, Received, and draft in a code block', () => {
    const p = payload(buildCardPayload(sampleRow()));
    const embed = p.embeds[0]!;
    expect(embed.title).toBe('Please list us');
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(byName['From']).toContain('Someone <someone@example.com>');
    expect(byName['Category']).toBe('listing_request');
    expect(byName['Received']).toContain('2026-06-20');
    expect(byName['Draft reply']).toContain('```');
    expect(byName['Draft reply']).toContain('recycleoldtech.com/claims');
  });

  it('handles missing name (From shows bare address)', () => {
    const p = payload(buildCardPayload(sampleRow({ fromName: null })));
    const embed = p.embeds[0]!;
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(byName['From']).toBe('someone@example.com');
  });

  it('handles empty draft (renders "(no draft)")', () => {
    const p = payload(buildCardPayload(sampleRow({ draftReply: null })));
    const embed = p.embeds[0]!;
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(byName['Draft reply']).toBe('*(no draft)*');
  });

  it('truncates long drafts to fit Discord 1024-char embed field limit', () => {
    const long = 'x'.repeat(2000);
    const p = payload(buildCardPayload(sampleRow({ draftReply: long })));
    const embed = p.embeds[0]!;
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    const draft = byName['Draft reply'] ?? '';
    if (draft.length > 1024) {
      console.error(`draft len=${draft.length} > 1024: ${draft.slice(0, 30)}…${draft.slice(-30)}`);
    }
    // The full field value including ``` fences must be <= 1024.
    expect(draft.length).toBeLessThanOrEqual(1024);
    // Truncation marker is present just before the closing code fence.
    expect(draft).toContain('…\n```');
  });
});

describe('buildResolvedCardPayload', () => {
  it('strips the action-row components (empty array) after action', () => {
    const p = payload(buildResolvedCardPayload(sampleRow(), 'sent') as ReturnType<typeof buildCardPayload>);
    expect(p.components).toEqual([]);
    expect(p.embeds[0]!.description).toContain('Sent');
  });

  it('marks send_failed in red with a warning', () => {
    const p = payload(buildResolvedCardPayload(sampleRow(), 'send_failed') as ReturnType<typeof buildCardPayload>);
    const embed = p.embeds[0]!;
    expect(embed.description).toContain('Send failed');
    expect(embed.color).toBe(0xb91c1c); // red
  });

  it('sent_edited distinguishes from plain sent', () => {
    const p = payload(buildResolvedCardPayload(sampleRow(), 'sent_edited') as ReturnType<typeof buildCardPayload>);
    expect(p.embeds[0]!.description).toContain('edited');
  });
});