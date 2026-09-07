import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function checkRelease(root = projectRoot) {
  const pkg = json(resolve(root, 'package.json'));
  const lock = json(resolve(root, 'package-lock.json'));
  const source = json(resolve(root, 'src/manifest.json'));
  const buildRoot = resolve(root, 'build');
  const built = json(resolve(buildRoot, 'manifest.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  for (const [label, value] of Object.entries({ 'lockfile root': lock.version, 'lockfile package': lock.packages?.['']?.version, 'source manifest': source.version, 'built manifest': built.version })) {
    assert.equal(value, pkg.version, `${label} version does not match package.json`);
  }
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const content = readFileSync(resolve(root, name), 'utf8');
    const version = content.match(/\*\*(?:Current version:|当前版本：)\*\*\s*(\d+\.\d+\.\d+)/)?.[1];
    assert.equal(version, pkg.version, `${name} current version is stale or missing`);
  }
  const requireAsset = (asset) => {
    assert.equal(typeof asset, 'string', 'Manifest asset must be a string');
    assert.ok(asset.length > 0 && !asset.includes('..'), `Unsafe packaged asset path: ${asset}`);
    const path = resolve(buildRoot, asset.replace(/^\//, ''));
    assert.ok(relative(buildRoot, path).split(sep)[0] !== '..', `Asset escapes build: ${asset}`);
    assert.ok(statSync(path).isFile(), `Missing packaged asset: ${asset}`);
  };
  const icons = (value) => typeof value === 'string' ? [value] : Object.values(value || {});
  const assets = [
    built.background?.service_worker,
    ...(built.background?.scripts || []),
    built.action?.default_popup,
    built.options_page,
    built.side_panel?.default_path,
    ...icons(built.action?.default_icon),
    ...icons(built.icons),
    ...(built.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    ...(built.declarative_net_request?.rule_resources || []).map((entry) => entry.path),
    `/_locales/${built.default_locale}/messages.json`,
    'THIRD_PARTY_NOTICES.md',
    'OPEN_PASSWORDS_NOTICE',
  ].filter(Boolean);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
  const files = walk(buildRoot);
  for (const entry of built.web_accessible_resources || []) {
    for (const asset of entry.resources || []) {
      if (!asset.includes('*')) assets.push(asset);
      else {
        const pattern = new RegExp(`^${asset.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        assert.ok(files.some((file) => pattern.test(relative(buildRoot, file).split(sep).join('/'))), `Web-accessible pattern matches no asset: ${asset}`);
      }
    }
  }
  for (const asset of assets) requireAsset(asset);
  for (const file of files.filter((path) => path.endsWith('.html'))) {
    const html = readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) {
      const link = match[1];
      if (/^(?:[a-z]+:|\/\/|#)/i.test(link)) continue;
      const path = link.startsWith('/') ? link.slice(1) : relative(buildRoot, resolve(dirname(file), link));
      requireAsset(path.split(/[?#]/)[0]);
    }
  }
  assert.ok(files.some((path) => relative(buildRoot, path).startsWith(`licenses${sep}`)), 'Packaged third-party licenses are missing');
  assert.ok(!files.some((path) => /(?:\.map$|\.env(?:\.|$)|\.pem$|\.key$)/i.test(path)), 'Unexpected development map or private-key/config asset in build');
  return { version: pkg.version, files: files.length, assetsChecked: assets.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkRelease();
  console.log(`Release checks passed: v${result.version}, ${result.files} packaged files, ${result.assetsChecked} manifest assets.`);
}
