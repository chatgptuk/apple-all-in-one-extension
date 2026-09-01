import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../build/contentScript.bundle.js', import.meta.url), 'utf8');

const createRuntime = ({ inputCount = 1, hoveredIndex, activeIndex } = {}) => {
  const documentListeners = new Map();
  const runtimeListeners = [];

  class FakeElement {
    constructor(ownerDocument) {
      this.ownerDocument = ownerDocument;
      this.isConnected = true;
      this.disabled = false;
      this.readOnly = false;
      this.isContentEditable = false;
      this.events = [];
      this.attributes = new Map();
      this.children = [];
      this.style = {
        values: new Map(),
        setProperty(name, value, priority = '') {
          this.values.set(name, { value, priority });
        },
      };
      this.classList = { add: (...names) => (this.className = names.join(' ')) };
    }

    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }

    attachShadow() {
      return { append: (...children) => this.children.push(...children) };
    }

    append(...children) {
      this.children.push(...children);
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    replaceChildren(...children) {
      this.children = children;
    }

    getBoundingClientRect() {
      return { width: 240, height: 36 };
    }
  }

  class FakeInput extends FakeElement {
    constructor(ownerDocument) {
      super(ownerDocument);
      this.type = 'email';
      this._value = '';
    }

    matches() {
      return true;
    }
  }

  Object.defineProperty(FakeInput.prototype, 'value', {
    get() {
      return this._value;
    },
    set(value) {
      this._value = value;
    },
  });

  class FakeTextarea extends FakeElement {
    constructor(ownerDocument) {
      super(ownerDocument);
      this._value = '';
    }
  }

  Object.defineProperty(FakeTextarea.prototype, 'value', {
    get() {
      return this._value;
    },
    set(value) {
      this._value = value;
    },
  });

  const document = {
    activeElement: undefined,
    createdElements: [],
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    querySelector(selector) {
      return selector.includes('input') ? this.inputs[0] : undefined;
    },
    querySelectorAll(selector) {
      if (selector === ':hover') return this.hovered;
      return selector.includes('input') ? this.inputs : [];
    },
    createElement(tagName) {
      const element = tagName === 'textarea' ? new FakeTextarea(this) : new FakeElement(this);
      element.tagName = tagName.toUpperCase();
      this.createdElements.push(element);
      return element;
    },
  };

  document.inputs = Array.from({ length: inputCount }, () => new FakeInput(document));
  document.hovered = Number.isInteger(hoveredIndex) ? [document.inputs[hoveredIndex]] : [];
  document.activeElement = Number.isInteger(activeIndex) ? document.inputs[activeIndex] : undefined;
  document.documentElement = new FakeElement(document);
  document.body = new FakeElement(document);

  class FakeEvent {
    constructor(type) {
      this.type = type;
    }
  }

  const sandbox = {
    chrome: {
      runtime: {
        id: 'test-extension',
        lastError: undefined,
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          },
          hasListener() {
            return false;
          },
          removeListener() {},
        },
      },
    },
    console,
    document,
    Event: FakeEvent,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextarea,
    InputEvent: FakeEvent,
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout,
    window: { setTimeout: () => 1, clearTimeout() {} },
  };

  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);

  const sendWrite = (data) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('content response timed out')), 500);
      const keepChannelOpen = runtimeListeners[0](
        { type: 5, data },
        { id: 'test-extension' },
        (response) => {
          clearTimeout(timeout);
          resolve(response);
        }
      );
      assert.equal(keepChannelOpen, true);
    });

  return { bundle, document, documentListeners, runtimeListeners, sandbox, sendWrite };
};

test('fills the exact editable element remembered by the contextmenu event', async () => {
  const runtime = createRuntime({ inputCount: 2 });
  const target = runtime.document.inputs[1];
  runtime.documentListeners.get('contextmenu')[0]({ composedPath: () => [target] });

  const response = await runtime.sendWrite({
    text: 'right-click@icloud.test',
    fill: true,
    copyToClipboard: false,
  });

  assert.equal(target.value, 'right-click@icloud.test');
  assert.equal(response.ok, true);
  assert.equal(response.filled, true);
  assert.equal(response.copied, false);
});

test('recovers the hovered editable element when injected after an extension reload', async () => {
  const runtime = createRuntime({ inputCount: 2, hoveredIndex: 1 });

  const response = await runtime.sendWrite({
    text: 'hover-recovery@icloud.test',
    fill: true,
    copyToClipboard: false,
  });

  assert.equal(runtime.document.inputs[1].value, 'hover-recovery@icloud.test');
  assert.equal(response.ok, true);
  assert.equal(response.filled, true);
});

test('uses the only visible email field as a safe recovery target', async () => {
  const runtime = createRuntime({ inputCount: 1 });

  const response = await runtime.sendWrite({
    text: 'single-field@icloud.test',
    fill: true,
    copyToClipboard: false,
  });

  assert.equal(runtime.document.inputs[0].value, 'single-field@icloud.test');
  assert.equal(response.ok, true);
});

test('reports an unavailable context target instead of claiming a silent fill', async () => {
  const runtime = createRuntime({ inputCount: 2 });

  const response = await runtime.sendWrite({
    text: 'do-not-fill@icloud.test',
    fill: true,
    copyToClipboard: false,
  });

  assert.equal(response.ok, false);
  assert.equal(response.filled, false);
  assert.equal(response.copied, false);
  assert.equal(response.error, 'context_target_unavailable');
  assert.deepEqual(runtime.document.inputs.map((input) => input.value), ['', '']);
});

test('renders terminal feedback in a page-pinned toast host', async () => {
  const runtime = createRuntime();

  const response = await runtime.sendWrite({
    status: 'success',
    message: 'Private address created and filled.',
    fill: false,
    copyToClipboard: false,
  });

  const host = runtime.document.createdElements.find((element) =>
    element.attributes.has('data-apple-all-in-one-toast')
  );
  assert.ok(host);
  assert.deepEqual(host.style.values.get('position'), { value: 'fixed', priority: 'important' });
  assert.deepEqual(host.style.values.get('z-index'), {
    value: '2147483647',
    priority: 'important',
  });
  assert.equal(response.ok, true);
});

test('programmatic reinjection remains idempotent', () => {
  const runtime = createRuntime();
  vm.runInContext(runtime.bundle, runtime.sandbox);
  assert.equal(runtime.runtimeListeners.length, 1);
  assert.equal(runtime.documentListeners.get('contextmenu').length, 1);
});
