import { describe, expect, it } from 'vitest';
import { signOutPlan } from './Shell';

describe('where Sign out posts', () => {
  it('posts to the page itself when #app names no account page', () => {
    for (const at of [undefined, {}, { signoutNext: '/account/?next=%2FTaskMind%2F' }, { signoutAction: '' }]) {
      expect(signOutPlan('tok', at)).toEqual({ action: './', fields: [['csrf', 'tok'], ['action', 'logout']] });
    }
  });

  it('posts to the account page, with the sign-in to return to, when #app names them', () => {
    expect(signOutPlan('tok', { signoutAction: '/account/', signoutNext: '/account/?next=%2FTaskMind%2F' })).toEqual({
      action: '/account/',
      fields: [['csrf', 'tok'], ['action', 'logout'], ['next', '/account/?next=%2FTaskMind%2F']],
    });
  });

  it('sends no next when the page names an action but no return target', () => {
    expect(signOutPlan('tok', { signoutAction: '/account/' })).toEqual({ action: '/account/', fields: [['csrf', 'tok'], ['action', 'logout']] });
  });
});
