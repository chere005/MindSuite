/** The site account is web-only; local native ledgers keep their existing identity and settings. */
export type SuiteAccount = { username: string; csrf: string; accountUrl: string; logoutAction: string; logoutNext: string };
export function suiteAccount(): SuiteAccount | null { return null; }
export function openSuiteAccount(_account: SuiteAccount): void {}
export function signOutSuiteAccount(_account: SuiteAccount): void {}
