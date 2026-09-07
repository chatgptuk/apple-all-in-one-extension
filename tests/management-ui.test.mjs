import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, read } from './source-harness.mjs';

const { selectManagedAddresses, sanitizeManagerView } = loadTs('src/pages/Popup/management-model.ts');
const { canRetryPasswordRequest } = loadTs('src/pages/Popup/password-requests.ts');
const aliases = Array.from({ length: 660 }, (_, index) => ({
  anonymousId: `alias-${index}`, hme: `private-${index}@icloud.com`,
  label: `Website ${index + 1}`, domain: 'example.test', note: index === 659 ? 'find me' : '',
  createTimestamp: 1000 - index, isActive: index % 2 === 0,
  lastReceivedAt: index === 90 ? 100 : undefined,
}));
const select = (options = {}) => selectManagedAddresses(aliases, { search: '', filter: 'all', sort: 'created', ...options });

test('all 660 addresses are available without pagination and search reaches the last entry', () => {
  assert.equal(select().length, 660);
  assert.equal(select().at(-1).anonymousId, 'alias-659');
  assert.equal(select({ search: 'FIND ME' }).length, 1);
  assert.equal(select({ search: 'FIND ME' })[0].anonymousId, 'alias-659');
  assert.equal(select({ search: 'private-90@' })[0].anonymousId, 'alias-90');
});

test('current website filtering uses resolved exact or associated IDs, not search text guesses', () => {
  const result = select({ filter: 'current', currentIds: new Set(['alias-2', 'alias-90']) });
  assert.equal(result.length, 2);
  assert.equal(result[0].anonymousId, 'alias-2');
  assert.equal(select({ filter: 'current' }).length, 0);
});

test('status and sort are deterministic without treating unobserved activity as unused', () => {
  assert.ok(select({ filter: 'active' }).every((alias) => alias.isActive));
  assert.ok(select({ filter: 'inactive' }).every((alias) => !alias.isActive));
  assert.equal(select({ sort: 'activity' })[0].anonymousId, 'alias-90');
  assert.equal(select({ sort: 'activity' }).length, aliases.length);
  assert.equal(select({ sort: 'label' })[1].label, 'Website 2');
  assert.equal(aliases[0].anonymousId, 'alias-0', 'original cached order is never mutated');
});

test('remembered manager state excludes account data, query and selected IDs', () => {
  const result = sanitizeManagerView({ filter: 'active', sort: 'activity', visibleCount: 101, scrollTop: 800, search: 'secret', selectedIds: ['private-id'], password: 'secret' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { filter: 'active', sort: 'activity', scrollTop: 800 });
  const invalid = sanitizeManagerView({ filter: 'delete', sort: 'password', visibleCount: Infinity, scrollTop: -1 });
  assert.equal(invalid.filter, 'all');
  assert.equal(invalid.sort, 'created');
  assert.equal(invalid.visibleCount, undefined, 'legacy pagination preferences are discarded');
  assert.equal(invalid.scrollTop, 0);
});

test('management wiring scopes presentation and activity by account and labels full selection explicitly', () => {
  const popup = read('src/pages/Popup/Popup.tsx');
  assert.match(popup, /hme-manager-view:\$\{hmeListCacheKey\(client\)\}/);
  assert.match(popup, /hme-mail-activity:\$\{hmeListCacheKey\(client\)\}/);
  assert.match(popup, /filtered\.map\(\(hme\) => \(/);
  assert.doesNotMatch(popup, /visibleCount|ADDRESS_PAGE_SIZE|hme-load-more|Show More Addresses/);
  assert.match(popup, /Select All \$\{filtered\.length\} Matching/);
  assert.match(popup, /filtered\.forEach\(\(item\) => next\.add/);
});

test('standalone manager hides password navigation and page filling, details-only mode is explicit', () => {
  const popup = read('src/pages/Popup/Popup.tsx');
  assert.match(popup, /IS_MANAGER \? 'hide-email' : 'passwords'/);
  assert.match(popup, /!IS_MANAGER && <AppSegmentedControl/);
  assert.match(popup, /if \(autofill && !IS_MANAGER\)/);
  assert.match(popup, /const fillAddress = async \(\) => \{\s+if \(IS_MANAGER\) return/);
  assert.match(popup, /type: 'fillOnPage', loginName: \{ username \}, mode/);
  assert.match(popup, /type: 'fillOtpOnPage', username: item\.username \|\| '', mode/);
  assert.match(popup, /View Details Only/);
  assert.match(popup, /Fill Again/);
});

test('a dropped response never replays secret reads or mutations that may already be authorized', () => {
  for (const type of ['fillOnPage', 'fillOtpOnPage', 'getOtpForLoginDetails', 'connect', 'setSitePreferences', 'clearCache']) {
    assert.equal(canRetryPasswordRequest(type, new Error('The message port closed before a response was received.')), false);
    assert.equal(canRetryPasswordRequest(type, new Error('Receiving end does not exist.')), true);
    assert.equal(canRetryPasswordRequest(type, new Error('Timed out waiting for fillOnPage')), false);
  }
  for (const type of ['getState', 'getLogins', 'getOtpItems', 'getSitePreferences', 'getDiagnostics']) {
    assert.equal(canRetryPasswordRequest(type, new Error('The message port closed before a response was received.')), true);
  }
  const popup = read('src/pages/Popup/Popup.tsx');
  assert.match(popup, /canRetryPasswordRequest\(message.type, error\)/);
  assert.match(popup, /type: 'fillOnPage'[^\n]*65_000/);
  assert.match(popup, /type: 'fillOtpOnPage'[^\n]*65_000/);
});

test('account changes unmount old lists and details before actions can bind to a new client', () => {
  const popup = read('src/pages/Popup/Popup.tsx');
  assert.match(popup, /const activeAccountKey = clientState \? hmeListCacheKey\(clientState\)/);
  assert.match(popup, /selectedAccountKey === activeAccountKey && \(/);
  assert.match(popup, /<ManageView\s+key=\{activeAccountKey\}/);
  assert.match(popup, /<GenerateView key=\{activeAccountKey\}/);
  assert.match(popup, /<DetailsView\s+key=\{`\$\{activeAccountKey\}:\$\{selected.anonymousId\}`\}/);
  assert.match(popup, /previousAccountKey.current = activeAccountKey;\s+setSelected\(undefined\);\s+setSelectedAccountKey\(''\)/);
  assert.match(popup, /event.type === 'hme:list-changed' && event.key === hmeListCacheKey\(client\)\) reloadLinks/);
  assert.match(popup, /!cancelled && revision === linksRevision\) setSiteLinks/);
});
