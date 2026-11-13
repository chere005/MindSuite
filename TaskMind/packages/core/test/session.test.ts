import { describe, expect, it } from 'vitest';
import { displayName, initials, isSession, screenFor } from '../src/session';

const session = { ok: true, me: 'alex', role: 'owner', name: '', csrf: 'x', theme: 'midnight' };

describe('which screen the first answer leads to', () => {
  it('opens the app only for a well-formed member session', () => {
    expect(screenFor({ status: 200, body: session })).toBe('signedIn');
    expect(screenFor({ status: 200, body: { ...session, role: 'god' } })).toBe('offline');
    expect(screenFor({ status: 200, body: { ...session, me: '' } })).toBe('offline');
    expect(screenFor({ status: 200, body: { ok: false } })).toBe('offline');
    expect(screenFor({ status: 200, body: null })).toBe('offline');
  });

  it('reads 401 as signed out and 403 as not on the team', () => {
    expect(screenFor({ status: 401, body: { error: 'Sign in', code: 'unauthorized' } })).toBe('signedOut');
    expect(screenFor({ status: 403, body: { error: 'No', code: 'forbidden' } })).toBe('denied');
  });

  it('never turns a failed read into an app: no reply, a 5xx and a 404 are offline', () => {
    for (const reply of [null, { status: 503, body: null }, { status: 500, body: session }, { status: 404, body: null }]) expect(screenFor(reply)).toBe('offline');
  });

  it('knows a session when it sees one', () => {
    expect(isSession(session)).toBe(true);
    expect(isSession(null)).toBe(false);
    expect(isSession('alex')).toBe(false);
  });
});

describe('names', () => {
  it('shows the given name, else the username with a capital', () => {
    expect(displayName('', 'alex')).toBe('Alex');
    expect(displayName('  Sam C  ', 'sam')).toBe('Sam C');
  });
  it('makes initials from two words, or the first two letters', () => {
    expect(initials('Sam Lee', 'sam')).toBe('SL');
    expect(initials('', 'alex')).toBe('AL');
    expect(initials('', 'a_b')).toBe('AB');
  });
});
