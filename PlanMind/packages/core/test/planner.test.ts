import { describe, it, expect } from 'vitest';
import * as planner from '../src/planner';
import { dateWindow, dayLabel, todayIn, periodStart, periodWindow, weekLabel, canonicalOwners, itemColor, resolveLanes, PERSON_ROLES, people, personLists, DEFAULT_SELECTION, type ListRecord } from '../src/planner';

describe('daily planner contract', () => {
  it('centers today with seven dates on each side through DST, year and leap boundaries', () => {
    for (const [today, first, last] of [['2026-11-01','2026-10-25','2026-11-08'],['2027-01-01','2026-12-25','2027-01-08'],['2028-02-29','2028-02-22','2028-03-07']]) {
      const days = dateWindow(today);
      expect(days).toHaveLength(15); expect(days[7]).toBe(today);
      expect(days[0]).toBe(first); expect(days[14]).toBe(last);
      expect(new Set(days).size).toBe(15);
    }
  });
  it('ownership is by list: the two people\'s lists are permanent, Both is a pair of owners and a view', () => {
    expect([...PERSON_ROLES]).toEqual(['partner', 'owner']);
    expect(personLists()).toEqual([people().partner, people().owner]);
    expect(canonicalOwners(['sam', 'alex'])).toEqual(['alex', 'sam']);
    expect(DEFAULT_SELECTION).toEqual({ base: 'both', overlays: [] });
    const lists = personLists().map((id, order) => ({ id, kind: 'person', name: id, color: id === people().partner ? 'yellow' : 'green', order, revision: 1, updatedAt: '' })) as ListRecord[];
    expect(resolveLanes(DEFAULT_SELECTION, lists, 'sam').map(l => l.listId)).toEqual(['sam', 'alex']);
    expect(itemColor(['sam', 'alex'], lists, { bothColor: 'purple', revision: 1, updatedAt: '' })).toBe('purple');
  });
  it('the old person filter API is gone from the core', () => {
    for (const name of ['visibleTasks', 'remaining']) expect(name in planner).toBe(false);
  });
  it('uses the shared household clock instead of the device timezone', () => {
    expect(todayIn('America/Chicago', new Date('2026-10-31T02:00:00Z'))).toBe('2026-10-30');
  });
  it('weeks are Monday–Sunday even across years and DST', () => {
    expect(periodStart('2027-01-03', 'week')).toBe('2026-12-28');
    expect(periodStart('2027-01-04', 'week')).toBe('2027-01-04');
    expect(weekLabel('2026-12-28')).toBe('Dec 28 – Jan 3');
    const weeks = periodWindow('2026-11-01', 'week');
    expect(weeks[7]).toBe('2026-10-26');
    expect(weeks.every(day => new Date(`${day}T12:00:00Z`).getUTCDay() === 1)).toBe(true);
  });
  it('labels a date as that calendar day on any device, even one 14 hours ahead of UTC', () => {
    const was = process.env.TZ;
    try {
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        expect(dayLabel('2026-10-30', { weekday: 'short', month: 'short', day: 'numeric' }), zone).toBe('Fri, Oct 30');
        expect(dayLabel('2026-12-31', { month: 'short', day: 'numeric' }), zone).toBe('Dec 31');
        expect(weekLabel('2026-12-28'), zone).toBe('Dec 28 – Jan 3');
      }
    } finally {
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  });
  it('month windows use first-of-month keys', () => {
    const months = periodWindow('2026-12-31', 'month');
    expect(months[7]).toBe('2026-12-01'); expect(months[8]).toBe('2027-01-01');
  });
});
