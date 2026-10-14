/** @param {HTMLInputElement} field */
export function passwordRole(field) {
  const ac = field.autocomplete.toLowerCase();
  const labels = Array.from(field.labels || []).map((label) => label.textContent || '').join(' ');
  const hints = `${field.id} ${field.name} ${field.placeholder} ${field.getAttribute('aria-label') || ''} ${labels}`;
  if (
    ac.includes('current-password') ||
    /(?:^|[\s_-])(?:old|current|existing)(?:[\s_-]|password)|旧密码|原密码|当前密码/i.test(
      hints
    )
  )
    return 'current';
  if (/confirm|repeat|retype|确认|確認|重复|重複/i.test(hints))
    return 'confirm';
  if (
    ac.includes('new-password') ||
    /new[\s_-]?(?:password|pwd)|新密码|新密碼/i.test(hints)
  )
    return 'new';
  return 'unknown';
}

/**
 * Inputs in document order, including those inside open shadow roots, so
 * web-component login fields (one input per custom element) are found too.
 * @param {ParentNode} root @returns {HTMLInputElement[]}
 */
export function deepInputs(root) {
  /** @type {HTMLInputElement[]} */
  const inputs = [];
  /** @param {any} scope */
  const visit = (scope) => {
    if (scope.shadowRoot) visit(scope.shadowRoot);
    const doc = scope.ownerDocument || scope;
    if (typeof doc.createTreeWalker !== 'function') {
      inputs.push(...scope.querySelectorAll('input'));
      return;
    }
    const walker = doc.createTreeWalker(scope, 1 /* NodeFilter.SHOW_ELEMENT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.localName === 'input') inputs.push(node);
      else if (node.shadowRoot) visit(node.shadowRoot);
    }
  };
  visit(root);
  return inputs;
}

/** @param {Element} node @returns {Element | null} */
function composedParent(node) {
  const root = /** @type {any} */ (node.getRootNode?.());
  return node.parentElement || root?.host || null;
}

/** @param {HTMLInputElement} anchor @returns {ParentNode} */
export function formScope(anchor) {
  if (anchor.form) return anchor.form;
  // Some layouts wrap every field in its own fieldset; such a wrapper is not a form.
  const explicit = anchor.closest('[role="form"], fieldset, [data-form]');
  if (
    explicit &&
    Array.from(explicit.querySelectorAll('input')).some(
      (field) => field !== anchor && field.type !== 'hidden'
    )
  )
    return explicit;
  // Form-less SPAs: choose the nearest group containing both identity and
  // password inputs, not every form in the document. A field inside a shadow
  // root may climb through its hosts, because component libraries isolate each input.
  const inShadow = anchor.getRootNode?.() !== anchor.ownerDocument;
  let parent = composedParent(anchor);
  while (parent) {
    const fields = (
      inShadow ? deepInputs(parent) : Array.from(parent.querySelectorAll('input'))
    ).filter(
      (field) => !field.form && !field.disabled && field.type !== 'hidden'
    );
    if (fields.length > 1 && fields.some((field) => field.type === 'password'))
      return parent;
    parent = composedParent(parent);
  }
  return (
    anchor.parentElement ||
    /** @type {Document | ShadowRoot} */ (anchor.getRootNode())
  );
}

/**
 * @param {HTMLInputElement} anchor
 * @param {(field: HTMLInputElement) => boolean} fillable
 */
export function generatedPasswordTargets(anchor, fillable) {
  if (!fillable(anchor) || passwordRole(anchor) === 'current') return [];
  const scope = formScope(anchor);
  const fields = deepInputs(scope).filter(
    (field) =>
      field.form === anchor.form && field.type === 'password' && fillable(field)
  );
  return [
    anchor,
    ...fields.filter(
      (field) =>
        field !== anchor &&
        !field.value &&
        ['new', 'confirm'].includes(passwordRole(field))
    ),
  ];
}
