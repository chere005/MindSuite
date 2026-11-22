import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePageResponse } from './verify-page.mjs';

const PROD = 'https://fixture.invalid/AcctMind/';
const TEST = 'https://test.fixture.invalid/AcctMind/';
const response = (status, locations = [], extra = []) => `HTTP/2 ${status}\r\n${[...locations.map(location => `Location: ${location}`), ...extra].join('\r\n')}\r\n\r\n`;
for (const [label, page, status, locations] of [
  ['legacy gate', PROD, '401', []], ['allowed shell', PROD, '200', []],
  ['relative production redirect', PROD, '303', ['/account/?next=%2FAcctMind%2F']],
  ['absolute production redirect', PROD, '303', ['https://fixture.invalid/account/?next=%2FAcctMind%2F']],
  ['relative TEST redirect', TEST, '303', ['/account/?next=%2FAcctMind%2F']],
  ['absolute TEST redirect', TEST, '303', ['https://test.fixture.invalid/account/?next=%2FAcctMind%2F']],
  ['mirror stays in its instance', 'https://fixture.invalid/test/AcctMind/', '303', ['/test/account/?next=%2Ftest%2FAcctMind%2F']],
]) test(label, () => assert.equal(validatePageResponse(page, status, response(status, locations)), status));

for (const [label, page, status, locations] of [
  ['server error', PROD, '500', []], ['permanent redirect', PROD, '301', ['/account/?next=/AcctMind/']],
  ['temporary redirect', PROD, '302', ['/account/?next=/AcctMind/']], ['method-preserving redirect', PROD, '307', ['/account/?next=/AcctMind/']],
  ['external origin', PROD, '303', ['https://external.invalid/account/?next=/AcctMind/']],
  ['TEST to production', TEST, '303', ['https://fixture.invalid/account/?next=/AcctMind/']],
  ['production to TEST', PROD, '303', ['https://test.fixture.invalid/account/?next=/AcctMind/']],
  ['other instance path', PROD, '303', ['/test/account/?next=/AcctMind/']],
  ['other account path', PROD, '303', ['/account/app/?next=/AcctMind/']],
  ['normalized other path', PROD, '303', ['/other/../account/?next=/AcctMind/']],
  ['encoded normalized path', PROD, '303', ['https://fixture.invalid/other/%2e%2e/account/?next=/AcctMind/']],
  ['other app return', PROD, '303', ['/account/?next=/MealMind/']],
  ['external return', PROD, '303', ['/account/?next=https%3A%2F%2Fexternal.invalid%2F']],
  ['missing return', PROD, '303', ['/account/']], ['duplicate return', PROD, '303', ['/account/?next=/AcctMind/&next=/AcctMind/']],
  ['encoded duplicate return', PROD, '303', ['/account/?next=/AcctMind/&%6eext=/AcctMind/']],
  ['extra parameter', PROD, '303', ['/account/?next=/AcctMind/&other=1']], ['fragment', PROD, '303', ['/account/?next=/AcctMind/#other']],
  ['missing Location', PROD, '303', []], ['empty Location', PROD, '303', ['']],
  ['duplicate Location', PROD, '303', ['/account/?next=/AcctMind/', '/account/?next=/AcctMind/']],
  ['scheme-relative URL', PROD, '303', ['//fixture.invalid/account/?next=/AcctMind/']],
  ['backslash URL', PROD, '303', ['https://fixture.invalid\\@external.invalid/account/?next=/AcctMind/']],
  ['userinfo', PROD, '303', ['https://user@fixture.invalid/account/?next=/AcctMind/']],
]) test(`refuses ${label}`, () => assert.throws(() => validatePageResponse(page, status, response(status, locations))));

test('duplicate Location names are case insensitive', () => assert.throws(() => validatePageResponse(PROD, '303', response('303', ['/account/?next=/AcctMind/'], ['location: /account/?next=/AcctMind/']))));
test('folded headers are refused', () => assert.throws(() => validatePageResponse(PROD, '303', response('303', ['/account/?next=/AcctMind/'], [' Location: /account/?next=/AcctMind/']))));
test('reported and header status must agree', () => assert.throws(() => validatePageResponse(PROD, '200', response('500'))));
test('an informational response may precede the final response', () => assert.equal(validatePageResponse(PROD, '303', 'HTTP/1.1 103 Early Hints\r\nLink: </asset>\r\n\r\n' + response('303', ['/account/?next=/AcctMind/'])), '303'));
