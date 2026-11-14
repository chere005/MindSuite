import { describe, expect, it } from 'vitest';
import { createCarry } from './carry';

const OWNER = ['alex'], BOTH = ['alex', 'sam'];

describe('the people a to-do list carries from one Enter to the next', () => {
  it('follows the picker when nothing was carried', () => {
    const carry = createCarry();
    expect(carry.owners('day:2040-01-01', 'both', BOTH)).toEqual(BOTH);
    expect(carry.owners('day:2040-01-01', 'sam', ['sam'])).toEqual(['sam']);
  });

  it('keeps the people of the to-do just entered while the person keeps writing on the same day under the same picker', () => {
    const carry = createCarry();
    carry.set(OWNER, 'day:2040-01-01', 'both');
    expect(carry.owners('day:2040-01-01', 'both', BOTH)).toEqual(OWNER);
    expect(carry.owners('day:2040-01-01', 'both', BOTH)).toEqual(OWNER);
    expect(carry.active).toBe(true);
  });

  it('is dropped, for good, when the picker changes', () => {
    const carry = createCarry();
    carry.set(OWNER, 'day:2040-01-01', 'both');
    expect(carry.owners('day:2040-01-01', 'sam', ['sam'])).toEqual(['sam']);
    expect(carry.active).toBe(false);
    // Going back to the first picker does not bring it back.
    expect(carry.owners('day:2040-01-01', 'both', BOTH)).toEqual(BOTH);
  });

  it('is dropped, for good, when the day, week or month changes', () => {
    const carry = createCarry();
    carry.set(OWNER, 'day:2040-01-01', 'both');
    expect(carry.owners('day:2040-01-02', 'both', BOTH)).toEqual(BOTH);
    expect(carry.owners('day:2040-01-01', 'both', BOTH)).toEqual(BOTH);
    carry.set(OWNER, 'week:2040-01-02', 'both');
    expect(carry.owners('month:2040-01-01', 'both', BOTH)).toEqual(BOTH);
    expect(carry.active).toBe(false);
  });

  it('is dropped by drop(), and a later set replaces an earlier one', () => {
    const carry = createCarry();
    carry.set(OWNER, 'day:2040-01-01', 'both');
    carry.set(BOTH, 'day:2040-01-01', 'both');
    expect(carry.owners('day:2040-01-01', 'both', ['x'])).toEqual(BOTH);
    carry.drop();
    expect(carry.active).toBe(false);
    expect(carry.owners('day:2040-01-01', 'both', ['x'])).toEqual(['x']);
  });
});
