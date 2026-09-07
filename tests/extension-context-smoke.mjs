/** CI-only real Chromium extension-context smoke. Never uses a user's profile/native host.
 * Run after building, with APPLE_CI_PLAYWRIGHT_DIR pointing to an isolated pinned install.
 * This is not part of `npm test` and must not be run as an alternate local UI browser.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.env.CI, 'true', 'This browser harness is CI-only; use the Codex built-in browser for local UI checks.');
assert.ok(process.env.APPLE_CI_PLAYWRIGHT_DIR, 'An isolated Playwright installation is required');
const { chromium } = await import(pathToFileURL(join(process.env.APPLE_CI_PLAYWRIGHT_DIR, 'node_modules/playwright/index.mjs')).href);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'apple-extension-ci-'));
const extensionPath = join(temporary, 'extension');
const profilePath = join(temporary, 'profile');
let context;
const servers = [];
const form = '<!doctype html><meta charset="utf-8"><title>Synthetic sign in</title><form><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="button">Sign in</button></form>';
const startServer = async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(request.url.startsWith('/embedded') ? `${form}<iframe title="Synthetic login" src="/login?frame=1"></iframe>` : form);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};
const until = async (fn, label) => {
  const deadline = Date.now() + 10_000;
  let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${last?.message || 'timed out'}`);
};

try {
  // Only the temporary copy receives the fake adapter and test worker. Production
  // build files, native protocol, manifest and bundle remain byte-for-byte intact.
  await cp(join(root, 'build'), extensionPath, { recursive: true });
  await cp(join(root, 'src/passwords'), join(extensionPath, 'ci-source/passwords'), { recursive: true });
  await cp(join(root, 'tests/fixtures/ci-native-protocol.js'), join(extensionPath, 'ci-source/passwords/core/protocol.js'));
  await writeFile(join(extensionPath, 'ci-worker.js'), `import './ci-source/passwords/core/background.js';\nchrome.runtime.onMessage.addListener((message, _sender, reply) => { if(message?.type === 'hme:inline-state'){ reply({ok:true,ready:false}); return false; } });\n`);
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  delete manifest.key;
  manifest.background = { service_worker: 'ci-worker.js', type: 'module' };
  // Even if a test fixture regresses, nativeMessaging cannot reach the user's helper.
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
  await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
  const [origin, foreignOrigin] = await Promise.all([startServer(), startServer()]);
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  // Test pages are loopback only. No target-site, iCloud, or credential traffic.
  await context.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await until(() => worker.evaluate(() => !!globalThis.__CI_NATIVE__), 'test worker initialized');
  const page = await context.newPage();
  const other = await context.newPage();
  await page.goto(`${origin}/login?landing_page=%2F`);
  await other.goto(`${foreignOrigin}/login`);
  const tabFor = async (url) => until(() => worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, url), 'fixture tab visible to extension');
  const tabId = await tabFor(page.url());
  const otherId = await tabFor(other.url());
  const prepare = (targetTab, expectedOrigin = origin, frameId = 0) => until(
    () => worker.evaluate(({ targetTab, expectedOrigin, frameId }) => chrome.tabs.sendMessage(targetTab, { type: 'prepareFill', expectedOrigin }, { frameId }), { targetTab, expectedOrigin, frameId }),
    'real content script preparation',
  );
  const requestFill = async (targetTab, username, documentToken, frameId = 0) => worker.evaluate(async ({ targetTab, username, documentToken, frameId }) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab, frameIds: [frameId] },
      func: async (username, documentToken) => chrome.runtime.sendMessage({ type: 'inlineFill', loginName: { username }, documentToken }),
      args: [username, documentToken],
    });
    return results[0]?.result;
  }, { targetTab, username, documentToken, frameId });
  const deliver = (targetTab, lease, expectedOrigin = origin, frameId = 0) => worker.evaluate(({ targetTab, lease, expectedOrigin, frameId }) => chrome.tabs.sendMessage(targetTab, {
    type: 'fill', username: 'synthetic-user', password: 'ci-only-replay', expectedOrigin,
    expectedHref: lease.href, expectedDocumentToken: lease.documentToken, targetToken: lease.targetToken,
  }, { frameId }), { targetTab, lease, expectedOrigin, frameId });

  // Actual Chrome sender/document metadata on a locale-rewritten SPA.
  await page.evaluate(() => history.replaceState({}, '', '/zh/login?landing_page=/'));
  let lease = await prepare(tabId);
  let result = await requestFill(tabId, 'synthetic-user', lease.documentToken);
  assert.equal(result.filled, true, 'same-document locale routing remains fillable');
  assert.equal(await page.locator('input[name="password"]').inputValue(), 'ci-only-synthetic-user');
  assert.equal(await other.locator('input[name="password"]').inputValue(), '', 'another active tab is untouched');
  assert.equal((await deliver(tabId, lease)).filled, false, 'consumed/stale lease cannot be replayed');
  assert.equal((await deliver(otherId, lease)).filled, false, 'cross-origin delivery is rejected');
  assert.equal(await other.locator('input[name="password"]').inputValue(), '');
  console.log('PASS actual sender metadata, SPA route, multi-tab isolation, cross-origin/replay rejection');

  // Hold a synthetic native read while the real DOM changes.
  await page.reload();
  lease = await prepare(tabId);
  const count = await worker.evaluate(() => { globalThis.__CI_NATIVE__.delayMs = 700; return globalThis.__CI_NATIVE__.reads; });
  const inFlight = requestFill(tabId, 'navigation-account', lease.documentToken);
  await until(() => worker.evaluate((count) => globalThis.__CI_NATIVE__.reads > count, count), 'synthetic authorization in flight');
  await page.evaluate(() => history.pushState({}, '', '/next-step'));
  result = await inFlight;
  assert.equal(result.filled, false, 'route changes during authorization fail closed');
  assert.equal(await page.locator('input[name="password"]').inputValue(), '');
  await worker.evaluate(() => { globalThis.__CI_NATIVE__.delayMs = 0; });

  await page.reload();
  lease = await prepare(tabId);
  await page.locator('input[name="username"]').evaluate((field) => field.replaceWith(field.cloneNode()));
  assert.equal((await deliver(tabId, lease)).filled, false, 'replaced field fails closed');
  lease = await prepare(tabId);
  await page.reload();
  await prepare(tabId);
  assert.equal((await deliver(tabId, lease)).filled, false, 'replaced document fails closed');
  assert.equal(await page.locator('input[name="password"]').inputValue(), '');
  console.log('PASS post-authorization navigation, replaced fields/documents do not receive secrets');

  await page.goto(`${origin}/embedded`);
  const embeddedId = await tabFor(page.url());
  const frameId = await until(() => worker.evaluate(async (tabId) => {
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href });
    return frames.find((frame) => frame.result.includes('frame=1'))?.frameId;
  }, embeddedId), 'iframe content is ready');
  lease = await prepare(embeddedId, origin, frameId);
  result = await requestFill(embeddedId, 'iframe-account', lease.documentToken, frameId);
  assert.equal(result.filled, true);
  assert.equal(await page.frameLocator('iframe').locator('input[name="password"]').inputValue(), 'ci-only-iframe-account');
  assert.equal(await page.locator('input[name="password"]').inputValue(), '', 'iframe fill never writes into the top-level form');
  console.log('PASS real iframe/document-targeted secret delivery');

  const replacement = context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  worker = await replacement;
  await until(() => worker.evaluate(() => !!globalThis.__CI_NATIVE__), 'replacement extension worker ready');
  await page.goto(`${origin}/login?afterReload=1`);
  const reloadedTab = await tabFor(page.url());
  lease = await prepare(reloadedTab);
  result = await requestFill(reloadedTab, 'after-reload-account', lease.documentToken);
  assert.equal(result.filled, true);
  assert.equal(await page.locator('input[name="password"]').inputValue(), 'ci-only-after-reload-account');
  console.log('PASS extension reload followed by refreshed page recovers actual runtime messaging');
  console.log('Extension-context smoke passed. Apple/native protocol/Touch ID were NOT tested.');
} finally {
  await context?.close();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  // Exact mkdtemp child only; never touches an existing browser profile/build.
  await rm(temporary, { recursive: true, force: true });
}
