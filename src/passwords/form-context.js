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

/** @param {HTMLInputElement} anchor @returns {ParentNode} */
export function formScope(anchor) {
  if (anchor.form) return anchor.form;
  const explicit = anchor.closest('[role="form"], fieldset, [data-form]');
  if (explicit) return explicit;
  // Form-less SPAs: choose the nearest group containing both identity and
  // password inputs, not every form in the document. Never cross shadow roots.
  let parent = anchor.parentElement;
  while (parent) {
    const fields = Array.from(parent.querySelectorAll('input')).filter(
      (field) => !field.form && !field.disabled && field.type !== 'hidden'
    );
    if (fields.length > 1 && fields.some((field) => field.type === 'password'))
      return parent;
    parent = parent.parentElement;
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
  const fields = Array.from(scope.querySelectorAll('input')).filter(
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
