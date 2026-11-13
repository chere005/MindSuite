import { describe, it, expect } from 'vitest';
import { exportFilename, exportStore, exportText } from '../src/backup';
import type { AnyRec } from '../src/index';

const rec = (id: string, type: string, updated: number, payload: object, deleted = false): AnyRec =>
  ({ id, type, updated, deleted, payload } as unknown as AnyRec);

describe('the export file', () => {
  it('carries every live record and none of the tombstones', () => {
    const recs = [
      rec('r1', 'reminder', 100, { text: 'alive' }),
      rec('n1', 'note', 200, { title: 'gone', body: 'the deleted secret' }, true),
      rec('h1', 'habit', 300, { name: 'run' }),
    ];
    const f = exportStore(recs, 'alex', 1_755_600_000_000);
    expect(f.records.map((r) => r.id)).toEqual(['h1', 'r1']);
    // The tombstone's payload must not survive into the file AT ALL — the
    // whole point of excluding it is that a backup is safe to leave around.
    expect(exportText(f)).not.toContain('the deleted secret');
    expect(f.counts).toEqual({ habit: 1, reminder: 1 });
    expect(f.account).toBe('alex');
    expect(f.format).toBe(1);
  });

  it('is deterministic: same store, same bytes, whatever the input order', () => {
    const a = [
      rec('b', 'note', 2, { title: 'B' }),
      rec('a', 'note', 1, { title: 'A' }),
      rec('z', 'folder', 3, { name: 'F' }),
    ];
    const b = [...a].reverse();
    const now = 1_755_600_000_000;
    expect(exportText(exportStore(a, 's', now))).toBe(exportText(exportStore(b, 's', now)));
  });

  it('drops superseded conversions with the other tombstones', () => {
    const recs = [
      { ...rec('c', 'reminder', 5, { text: 'became a note' }, true), superseded: true } as AnyRec,
      rec('n', 'note', 6, { title: 'the note it became' }),
    ];
    const f = exportStore(recs, 's', 0);
    expect(f.records.map((r) => r.id)).toEqual(['n']);
    // And the record shape stays exactly the wire shape — no stray fields.
    expect(Object.keys(f.records[0]!).sort()).toEqual(['id', 'payload', 'type', 'updated']);
  });

  it('names the file for the account and the day, filesystem-safely', () => {
    expect(exportFilename('alex', '2026-08-19T21:04:00.000Z')).toBe('calmind-alex-2026-08-19.json');
    expect(exportFilename('we/ird name', '2026-01-02T00:00:00.000Z')).toBe('calmind-we_ird_name-2026-01-02.json');
  });

  it("carries ChefMind's space when the app holds it, on the same terms (#81)", () => {
    const mine = [{ id: 'r1', type: 'reminder', updated: 1, payload: { text: 'a' } }] as unknown as AnyRec[];
    const chef = [
      { id: 'n2', type: 'note', updated: 2, payload: { title: 'stew' } },
      { id: 'n1', type: 'note', updated: 1, payload: { title: 'soup' } },
      { id: 'gone', type: 'note', updated: 3, deleted: true, payload: { title: 'deleted' } },
    ] as unknown as AnyRec[];
    const file = exportStore(mine, 'alex', 0, { chef });
    expect(file.chef?.counts).toEqual({ note: 2 });
    expect(file.chef?.records.map((r) => r.id), 'live only, sorted').toEqual(['n1', 'n2']);
    expect(file.records.map((r) => r.id)).toEqual(['r1']);
  });

  it('without a chef space the file is exactly what it always was', () => {
    const mine = [{ id: 'r1', type: 'reminder', updated: 1, payload: { text: 'a' } }] as unknown as AnyRec[];
    const file = exportStore(mine, 'alex', 0);
    expect('chef' in file).toBe(false);
    expect(Object.keys(file)).toEqual(['app', 'format', 'exported', 'account', 'counts', 'records']);
  });
});
