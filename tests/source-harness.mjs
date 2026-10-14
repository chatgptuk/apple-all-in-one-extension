import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import { randomToken } from '../src/passwords/random-token.js';
import { normalizeNativeTarget } from '../src/passwords/core/native-target.js';
import * as contracts from '../src/passwords/message-contracts.js';
import { deepInputs, passwordRole } from '../src/passwords/form-context.js';

export const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export function loadTs(path, imports = {}, globals = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    require: (id) => {
      if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
      return imports[id];
    },
    AbortController,
    URL,
    TypeError,
    Error,
    Date,
    setTimeout,
    clearTimeout,
    console,
    ...globals,
  });
  return module.exports;
}
export function functionsFrom(path, names, globals = {}) {
  const source = read(path);
  const tree = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const bodies = [];
  const walk = (node) => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
      bodies.push(node.getText(tree));
    // Shared hint patterns are top-level constants; allow tests to load them by name too.
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.length === 1 &&
      names.includes(node.declarationList.declarations[0].name.getText(tree))
    )
      bodies.push(node.getText(tree));
    ts.forEachChild(node, walk);
  };
  walk(tree);
  if (bodies.length !== names.length)
    throw new Error(`Missing function in ${path}`);
  const context = vm.createContext({
    URL,
    console,
    crypto: webcrypto,
    Date,
    setTimeout,
    clearTimeout,
    // Function-isolation tests can opt into the real lifecycle helpers explicitly.
    scheduleSecretCleanup: () => {},
    sitePreferences: { suggestions: 'automatic', privateSignup: true },
    sitePreferencesReady: Promise.resolve(),
    ...globals,
  });
  vm.runInContext(bodies.join('\n'), context);
  return context;
}
// The content listener delegates fill-target choice to these real helpers, evaluated in the
// same context so they see each test's DOM stubs.
export function contentMessageHandler(globals) {
  return runtimeMessageHandler('src/passwords/content.js', globals, ['fillTargetFor', 'bestLoginField']);
}
export function runtimeMessageHandler(path, globals, helpers = []) {
  const source = read(path);
  const tree = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  let handler;
  const bodies = [];
  const walk = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'chrome.runtime.onMessage.addListener'
    )
      handler = node.arguments[0].getText(tree);
    if (ts.isFunctionDeclaration(node) && helpers.includes(node.name?.text))
      bodies.push(node.getText(tree));
    ts.forEachChild(node, walk);
  };
  walk(tree);
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    randomToken,
    ...contracts,
    normalizeNativeTarget,
    deepInputs,
    passwordRole,
    recordDiagnostic: () => {},
    Date,
    scheduleSecretCleanup: () => {},
    ...globals,
  });
  if (bodies.length !== helpers.length) throw new Error(`Missing helper in ${path}`);
  vm.runInContext(`${bodies.join('\n')}\nglobalThis.listener = ${handler}`, context);
  return context;
}
