import { describe, it, expect } from 'vitest';
import {
  changed,
  diffFields,
  richTextPreview,
  RICH_TEXT_PREVIEW_MAX,
  type ActivityDiffConfig,
} from './activity-diff';

interface Item extends Record<string, unknown> {
  name: string;
  points: number | null;
  notes: string | null;
}

describe('changed', () => {
  it('treats null and undefined as equal (no change)', () => {
    expect(changed(null, undefined)).toBe(false);
    expect(changed(undefined, null)).toBe(false);
    expect(changed(null, null)).toBe(false);
  });

  it('compares by stable string form', () => {
    expect(changed(3, '3')).toBe(false);
    expect(changed(3, 4)).toBe(true);
    expect(changed(null, 0)).toBe(true);
    expect(changed('a', 'b')).toBe(true);
  });
});

describe('richTextPreview', () => {
  it('returns null for every shape of absence, so "(empty)" keeps meaning empty', () => {
    expect(richTextPreview(null)).toBeNull();
    expect(richTextPreview(undefined)).toBeNull();
    expect(richTextPreview('')).toBeNull();
    // What the editor leaves behind when a field is cleared: markup with no text in it.
    expect(richTextPreview('<p></p>')).toBeNull();
    expect(richTextPreview('<p>&nbsp;</p>')).toBeNull();
  });

  it('decodes the entities the editor writes, so a preview reads as the reader typed it', () => {
    expect(richTextPreview('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>')).toBe(
      'a & b <c> "d" \'e\'',
    );
  });
});

describe('diffFields', () => {
  const config: ActivityDiffConfig<Item> = {
    fields: ['name', 'points', 'notes'],
    richText: ['notes'],
    action: (f) => `item.${f}_changed`,
  };

  it('emits only fields present in input AND actually changed', () => {
    const before: Item = { name: 'A', points: 3, notes: 'x' };
    const out = diffFields(before, { name: 'B', points: 3 }, config);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      action: 'item.name_changed',
      change: { field: 'name', old: 'A', new: 'B' },
    });
  });

  /**
   * DE-18, INVERTED. This used to assert `old: null, new: null` for a rich-text field — which is
   * exactly what the reader saw as "Notes changed from (empty) to (empty)" for an edit that saved
   * real text. A rich-text change now records a bounded plain-text PREVIEW of each side.
   */
  it('records a rich-text change as a plain-text preview of each side, never the markup', () => {
    const before: Item = { name: 'A', points: 3, notes: '<p>old body</p>' };
    const out = diffFields(before, { notes: '<p>new <strong>body</strong></p>' }, config);
    expect(out).toEqual([
      {
        action: 'item.notes_changed',
        change: { field: 'notes', old: 'old body', new: 'new body' },
      },
    ]);
  });

  it('keeps an absent or blank rich-text side null, so "(empty)" still means empty', () => {
    const before: Item = { name: 'A', points: 3, notes: null };
    const filled = diffFields(before, { notes: '<p>first note</p>' }, config);
    expect(filled[0].change).toEqual({ field: 'notes', old: null, new: 'first note' });

    // Markup carrying no text is an empty field, not a value — `<p></p>` is what the editor
    // leaves behind when the reader clears it.
    const cleared = diffFields(
      { ...before, notes: '<p>first note</p>' },
      { notes: '<p></p>' },
      config,
    );
    expect(cleared[0].change).toEqual({ field: 'notes', old: 'first note', new: null });
  });

  it('bounds a rich-text preview, so one row can never carry a whole document', () => {
    // Annotated `Item`, not an inline literal: `diffFields` infers `T` from `before`, so a literal
    // `notes: null` narrows `T['notes']` to `null` and the string below stops being assignable.
    const before: Item = { name: 'A', points: 1, notes: null };
    const long = 'x'.repeat(RICH_TEXT_PREVIEW_MAX + 50);
    const out = diffFields(before, { notes: long }, config);
    const preview = out[0].change.new as string;

    expect(preview).toHaveLength(RICH_TEXT_PREVIEW_MAX + 1); // + the ellipsis
    expect(preview.endsWith('…')).toBe(true);
  });

  it('separates block boundaries, so two paragraphs do not read as one word', () => {
    const before: Item = { name: 'A', points: 1, notes: null };
    const out = diffFields(before, { notes: '<p>alpha</p><p>beta</p>' }, config);

    expect(out[0].change.new).toBe('alpha beta');
  });

  it('preserves config field order and omits the action when unconfigured', () => {
    const before: Item = { name: 'A', points: 1, notes: null };
    const out = diffFields(
      before,
      { points: 2, name: 'B' },
      { fields: ['name', 'points', 'notes'] },
    );
    expect(out.map((e) => e.change.field)).toEqual(['name', 'points']);
    expect(out[0].action).toBeUndefined();
  });

  it('ignores undefined input fields (partial update) and coerces null defaults', () => {
    const before: Item = { name: 'A', points: null, notes: null };
    const out = diffFields(before, { points: 5 }, config);
    expect(out).toEqual([
      { action: 'item.points_changed', change: { field: 'points', old: null, new: 5 } },
    ]);
  });
});
