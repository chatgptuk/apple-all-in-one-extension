import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import { randomToken } from '../src/passwords/random-token.js';

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
    ...globals,
  });
  vm.runInContext(bodies.join('\n'), context);
  return context;
}
export function contentMessageHandler(globals) {
  const source = read('src/passwords/content.js');
  const tree = ts.createSourceFile(
    'content.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  let handler;
  const walk = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'chrome.runtime.onMessage.addListener'
    )
      handler = node.arguments[0].getText(tree);
    ts.forEachChild(node, walk);
  };
  walk(tree);
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    randomToken,
    Date,
    ...globals,
  });
  vm.runInContext(`globalThis.listener = ${handler}`, context);
  return context;
}
