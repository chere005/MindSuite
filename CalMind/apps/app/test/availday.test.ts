import { expect, test } from 'vitest';
import { DayReader, slotsFor, type AvDay, type AvDayReply } from '../src/availday';

// The availability editor's day read, with a fake API whose replies are held
// until the test answers them, in any order.

function setup() {
  const calls: Array<{ date: string; ok: (r: AvDayReply) => void; fail: () => void }> = [];
  const days: AvDay[] = [];
  const owners: boolean[] = [];
  const r = new DayReader(
    (date) => new Promise((ok, fail) => calls.push({ date, ok, fail: () => fail(new Error('down')) })),
    (d) => days.push(d), (o) => owners.push(o));
  return { r, calls, days, owners, last: () => days.at(-1)! };
}
const slots = (t: string) => [{ time: t, busy: false }];
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('no hours are shown for a date until the reply for THAT date has arrived', async () => {
  const t = setup();
  t.r.select('2030-01-07');
  t.calls[0].ok({ owner: true, slots: slots('10:00') }); await settle();
  expect(slotsFor(t.last(), '2030-01-07')).toEqual(slots('10:00'));
  t.r.select('2030-01-08');
  // the screen's date has moved on; the previous day's hours are not for it
  expect(slotsFor(t.last(), '2030-01-08')).toBeNull();
  expect(slotsFor({ date: '2030-01-07', slots: slots('10:00'), failed: false }, '2030-01-08')).toBeNull();
});

test('a reply for a date that is no longer selected is ignored, in any order', async () => {
  const t = setup();
  t.r.select('2030-01-07');
  t.r.select('2030-01-08');
  t.calls[1].ok({ owner: true, slots: slots('11:00') }); await settle();
  t.calls[0].ok({ owner: true, slots: slots('09:00') }); await settle();
  expect(t.last().date).toBe('2030-01-08');
  expect(slotsFor(t.last(), '2030-01-08')).toEqual(slots('11:00'));
});

test('a late reply for the old date never fills the new date, and a failure for it is silent', async () => {
  const t = setup();
  t.r.select('2030-01-07');
  t.r.select('2030-01-08');
  t.calls[0].ok({ owner: true, slots: slots('09:00') }); await settle();
  expect(slotsFor(t.last(), '2030-01-08')).toBeNull();
  t.calls[0].fail(); await settle();
  expect(t.last().failed).toBe(false);
  t.calls[1].fail(); await settle();
  expect(t.last()).toEqual({ date: '2030-01-08', slots: null, failed: true });
});

test('after dispose nothing is delivered', async () => {
  const t = setup();
  t.r.select('2030-01-07');
  const n = t.days.length;
  t.r.dispose();
  t.calls[0].ok({ owner: true, slots: [] }); await settle();
  expect(t.days).toHaveLength(n);
});

test('retry after a failed read asks again for the same date, with the hours empty meanwhile', async () => {
  const t = setup();
  t.r.select('2030-01-07');
  t.calls[0].fail(); await settle();
  expect(t.last()).toEqual({ date: '2030-01-07', slots: null, failed: true });
  t.r.retry();
  expect(t.calls).toHaveLength(2);
  expect(t.calls[1].date).toBe('2030-01-07');
  expect(t.last()).toEqual({ date: '2030-01-07', slots: null, failed: false });
  t.calls[1].ok({ owner: true, slots: slots('10:00') }); await settle();
  expect(slotsFor(t.last(), '2030-01-07')).toEqual(slots('10:00'));
});

test('a retry that fails again says so again', async () => {
  const t = setup();
  t.r.select('2030-01-07');
  t.calls[0].fail(); await settle();
  t.r.retry();
  t.calls[1].fail(); await settle();
  expect(t.last()).toEqual({ date: '2030-01-07', slots: null, failed: true });
});

test('a reply to the read before a retry is ignored, and so are replies for other dates', async () => {
  const t = setup();
  t.r.select('2030-01-07');
  t.r.retry();
  t.calls[0].ok({ owner: true, slots: slots('09:00') }); await settle();
  expect(slotsFor(t.last(), '2030-01-07')).toBeNull(); // the first read is void
  t.calls[1].ok({ owner: true, slots: slots('10:00') }); await settle();
  expect(slotsFor(t.last(), '2030-01-07')).toEqual(slots('10:00'));
  t.r.select('2030-01-08');
  t.r.retry();
  t.calls[2].ok({ owner: true, slots: slots('07:00') }); await settle(); // for the day before: ignored
  expect(t.last().date).toBe('2030-01-08');
  expect(slotsFor(t.last(), '2030-01-08')).toBeNull();
});

test('retry before any selection does nothing', () => {
  const t = setup();
  t.r.retry();
  expect(t.calls).toHaveLength(0);
});

test('retry after dispose does nothing', () => {
  const t = setup();
  t.r.select('2030-01-07');
  t.r.dispose();
  t.r.retry();
  expect(t.calls).toHaveLength(1);
});
