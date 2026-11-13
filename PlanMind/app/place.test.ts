import { describe, it, expect } from 'vitest';
import { encodePlace, parsePlace, type Place } from './place';

const place = (over: Partial<Place> = {}): Place => ({ view: 'week', date: '2041-03-04', chores: false, back: null, tab: null, ...over });

describe('the place a page reloads to', () => {
  it('every part of it survives the hash', () => {
    for (const p of [
      place(),
      place({ view: 'month', date: '2041-06-01', tab: 'calendar' }),
      place({ view: 'day', date: '2041-06-15', chores: true }),
      place({ view: 'day', date: '2041-06-15', back: 'month', tab: 'todo' }),
      place({ view: 'day', date: '2099-12-31', back: 'week', tab: 'schedule', chores: true }),
    ]) { expect(parsePlace(encodePlace(p)), encodePlace(p)).toEqual(p); }
  });
  it('is a hash and nothing else: no words of the person, no storage', () => {
    expect(encodePlace(place())).toBe('#view=week&date=2041-03-04');
    expect(encodePlace(place({ view: 'day', back: 'month', tab: 'todo', chores: true }))).toBe('#view=day&date=2041-03-04&chores=1&back=month&tab=todo');
  });
  it('no hash, an empty one or another one names no place', () => {
    for (const hash of ['', '#', '#top', '#/week/2041-03-04', 'view=week']) { expect(parsePlace(hash), hash).toBeNull(); }
  });
  it('a view or a date that is off names no place: it is not trusted halfway', () => {
    for (const hash of [
      '#view=year&date=2041-03-04', '#date=2041-03-04', '#view=week', '#view=week&date=', '#view=week&date=2041-3-4',
      // Shaped like a day but not one, and days the app does not offer.
      '#view=day&date=2041-02-30', '#view=day&date=2041-13-01', '#view=day&date=1999-12-31', '#view=day&date=2100-01-01', '#view=day&date=2041-03-04T12:00',
    ]) { expect(parsePlace(hash), hash).toBeNull(); }
  });
  it('a Back is a Day that was opened from another view; a tab is one of the view\'s own', () => {
    expect(parsePlace('#view=week&date=2041-03-04&back=month')).toBeNull();
    expect(parsePlace('#view=day&date=2041-03-04&back=day')).toBeNull();
    expect(parsePlace('#view=day&date=2041-03-04&back=year')).toBeNull();
    // Priorities is a tab of the Week and the Month, not of the Day.
    expect(parsePlace('#view=day&date=2041-03-04&tab=priorities')).toBeNull();
    expect(parsePlace('#view=week&date=2041-03-04&tab=priorities')).toMatchObject({ tab: 'priorities' });
    expect(parsePlace('#view=month&date=2041-03-01&tab=nonsense')).toBeNull();
    // Chores is on only when it says so.
    expect(parsePlace('#view=week&date=2041-03-04&chores=0')).toMatchObject({ chores: false });
    expect(parsePlace('#view=week&date=2041-03-04&chores=yes')).toMatchObject({ chores: false });
  });
});
