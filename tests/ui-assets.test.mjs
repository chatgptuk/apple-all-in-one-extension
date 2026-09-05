import assert from 'node:assert/strict';
import test from 'node:test';
import postcss from 'postcss';
import vm from 'node:vm';
import { read, functionsFrom } from './source-harness.mjs';

test('all production extension pages end on the shared Apple material tokens', () => {
  for (const page of ['popup', 'options', 'userguide']) {
    const css = postcss.parse(read(`build/${page}.css`));
    let accent;
    css.walkDecls('--hme-blue', (decl) => { accent = decl.value; });
    assert.equal(accent, 'var(--apple-blue)', page);
    const preferences = new Set();
    css.walkAtRules('media', (rule) => { preferences.add(rule.params); });
    for (const setting of ['prefers-reduced-motion: reduce', 'prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'forced-colors: active'])
      assert.ok([...preferences].some((param) => param.includes(setting)), `${page}: ${setting}`);
  }
});

test('the isolated chooser can load its packaged theme without remote resources', () => {
  const theme = read('src/styles/apple-design.css');
  postcss.parse(theme);
  assert.equal(read('build/src/apple-design.css'), theme);
  assert.doesNotMatch(theme, /(?:https?:|@import|@font-face)/);
  assert.match(read('build/src/inline.html'), /href=["']?apple-design\.css["'\s>]/);
  const manifest = JSON.parse(read('build/manifest.json'));
  assert.ok(manifest.web_accessible_resources.some((entry) => entry.resources.includes('src/apple-design.css')));
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
});

test('popup and inline chooser share one validated icon catalog and packaged brand mark', () => {
  const catalog = JSON.parse(read('src/icons/symbols.json'));
  const context = vm.createContext({});
  vm.runInContext(read('build/src/symbols.js'), context);
  assert.equal(JSON.stringify(context.AppleAllInOneSymbols), JSON.stringify(catalog));
  for (const [name, paths] of Object.entries(catalog)) {
    assert.ok(paths.length > 0, name);
    for (const path of paths) assert.match(path, /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/, name);
  }
  const html = read('build/src/inline.html');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']?([^"'\s>]+)/g)].map((match) => match[1]);
  assert.ok(scripts.includes('symbols.js'));
  assert.ok(scripts.indexOf('symbols.js') < scripts.indexOf('inline.js'));
  const resources = JSON.parse(read('build/manifest.json')).web_accessible_resources.flatMap((entry) => entry.resources);
  for (const asset of ['symbols.js', 'brand-icon.svg']) assert.ok(resources.includes(`src/${asset}`));
  assert.equal(read('build/src/brand-icon.svg'), read('src/assets/img/icon-source.svg'));
  const ui = functionsFrom('src/passwords/inline.js', ['symbolSvg', 'svgKey', 'svgMail', 'svgCode', 'svgChevron'], { AppleAllInOneSymbols: catalog });
  for (const [fn, name] of [['svgKey', 'key'], ['svgMail', 'mail'], ['svgCode', 'code'], ['svgChevron', 'chevron-right']]) {
    const rendered = ui[fn]();
    for (const d of catalog[name]) assert.ok(rendered.includes(`d="${d}"`));
    assert.match(rendered, /fill="none" stroke="currentColor"/);
  }
});
