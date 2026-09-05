const secret = location.hash.slice(1);
let languagePreference = 'auto';
function resolveLanguage(pref = languagePreference) {
  if (pref === 'zh-CN') return 'zh-CN';
  if (pref === 'en') return 'en';
  let ui = 'en';
  try { ui = chrome.i18n?.getUILanguage?.() || navigator.language || 'en'; } catch (_) { ui = navigator.language || 'en'; }
  return /^zh(?:-|$)/i.test(ui) ? 'zh-CN' : 'en';
}
function L(en, zh) { const lang = currentState?.language || resolveLanguage(); return lang === 'zh-CN' ? zh : en; }
try {
  chrome.storage?.local?.get({ languagePreference: 'auto' }, (d) => {
    languagePreference = d.languagePreference || 'auto';
    document.documentElement.lang = resolveLanguage();
    applyStaticLocale();
    if (currentState) renderState(currentState);
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.languagePreference) {
      languagePreference = changes.languagePreference.newValue || 'auto';
      document.documentElement.lang = resolveLanguage();
      applyStaticLocale();
      if (currentState) renderState(currentState);
    }
  });
} catch (_) {}
const content = document.getElementById('content');
const hostLabel = document.getElementById('host');
const status = document.getElementById('status');
const closeBtn = document.getElementById('close');
let port = null;
let currentState = null;
let pinMode = false;
let passwordOverrides = {};

function applyStaticLocale() {
  document.documentElement.lang = resolveLanguage();
  const eyebrow = document.querySelector('.eyebrow');
  if (eyebrow) eyebrow.textContent = L('PASSWORDS & PRIVACY', '密码与隐私');
  if (!currentState && hostLabel) hostLabel.textContent = L('This Website', '此网站');
  closeBtn?.setAttribute('aria-label', L('Close', '关闭'));
  if (closeBtn) closeBtn.innerHTML = symbolSvg('close');
}
applyStaticLocale();

function safeHost(host) {
  return String(host || L('Passwords', '密码')).slice(0, 160);
}

// Only the packaged, fixed path catalog is interpolated, never page/account data.
function symbolSvg(name, chevron = false) {
  const paths = globalThis.AppleAllInOneSymbols?.[name] || [];
  return `<svg class="apple-symbol${chevron ? ' chevron' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

function svgKey() { return symbolSvg('key'); }

function svgMail() { return symbolSvg('mail'); }

function makeAppleSignInRow() {
  const button = document.createElement('button');
  button.className = 'row apple-signin-row';
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'row-icon apple-signin-icon';
  icon.textContent = '';
  const main = document.createElement('span');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = L('Continue with Apple', '使用 Apple 继续');
  const sub = document.createElement('div');
  sub.className = 'row-sub';
  sub.textContent = L('Apple sign-in is available on this page', '此页面支持使用 Apple 登录');
  main.append(title, sub);
  const action = document.createElement('span');
  action.className = 'row-action apple-signin-action';
  action.textContent = L('Continue', '继续');
  button.append(icon, main, action);
  button.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    clearStatus();
    send('use-apple-sign-in', {}, e, button);
  });
  return button;
}

function makeSmartSignupRow(state) {
  const button = document.createElement('button');
  button.className = 'row smart-signup-row';
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'row-icon smart-signup-icon';
  icon.innerHTML = svgMail();
  const main = document.createElement('span');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = state.existingHme?.hme || L('Private Signup', '私密注册');
  const sub = document.createElement('div');
  sub.className = 'row-sub';
  sub.textContent = state.existingHme?.hme
    ? L('Reuse this address and prepare a strong password', '复用此地址并准备强密码')
    : L('Create a private address and prepare a strong password', '创建隐藏地址并准备强密码');
  main.append(title, sub);
  const action = document.createElement('span');
  action.className = 'row-action';
  action.textContent = L('Use', '使用');
  button.append(icon, main, action);
  button.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    clearStatus();
    const generated = generateCompatiblePassword(state.passwordRequirements, true);
    if (!generated.password) {
      showStatus(L('This website’s password rules could not be satisfied safely. Use its own password generator or review the field requirements.', '无法安全满足此网站的密码规则，请使用网站自带的密码生成器或检查输入框要求。'));
      return;
    }
    button.disabled = true;
    action.textContent = L('Preparing…', '正在准备…');
    send('smart-signup', {
      hme: state.existingHme?.hme || '',
      password: generated.password,
    }, e, button);
  });
  return button;
}

function finishSignupOperation() {
  const button = content.querySelector('.smart-signup-row');
  if (!button) return;
  button.disabled = false;
  const action = button.querySelector('.row-action');
  if (action) action.textContent = L('Use', '使用');
}

function appendSmartSignup(state) {
  if (!state.hasAppleSignIn && !state.canSmartSignup) return false;
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = L('Smart Signup', '智能注册');
  content.appendChild(label);
  if (state.hasAppleSignIn) content.appendChild(makeAppleSignInRow());
  if (state.canSmartSignup) {
    content.appendChild(makeSmartSignupRow(state));
    appendPasswordControls(state.passwordRequirements || {});
  }
  return true;
}

function svgChevron() {
  return symbolSvg('chevron-right', true);
}

function clearStatus() {
  status.hidden = true;
  status.textContent = '';
}

function showStatus(message) {
  status.textContent = String(message || L('Something went wrong.', '出现了问题。'));
  status.hidden = false;
  reportHeight();
}

function pointForEvent(e, el) {
  if (!e?.isTrusted) return { gesture: false, x: 0, y: 0 };
  let x = Number(e.clientX) || 0;
  let y = Number(e.clientY) || 0;
  if (x <= 0 && y <= 0 && el) {
    const r = el.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }
  return { gesture: true, x, y };
}

function send(type, body = {}, e = null, el = null) {
  if (!port) return;
  port.postMessage({ type, ...body, ...pointForEvent(e, el) });
}

function reportHeight() {
  requestAnimationFrame(() => {
    const h = Math.ceil(document.documentElement.scrollHeight + 4);
    port?.postMessage({ type: 'resize', height: h });
  });
}

function generateCompatiblePassword(requirements = {}, allowSymbols = true) {
  const generator = globalThis.AppleAllInOnePasswordGenerator;
  if (!generator?.generateCompatiblePassword) return { password: '', compatible: false };
  return generator.generateCompatiblePassword(requirements, { ...passwordOverrides, allowSymbols });
}

function appendPasswordControls(requirements) {
  const details = document.createElement('details');
  details.className = 'password-controls';
  const summary = document.createElement('summary');
  summary.textContent = L('Adjust password', '调整密码');
  const lengthLabel = document.createElement('label');
  lengthLabel.textContent = L('Length', '长度');
  const length = document.createElement('input');
  length.type = 'number'; length.min = '8'; length.max = '128';
  length.value = String(passwordOverrides.length || Math.min(requirements.maxLength || 128, Math.max(20, requirements.minLength || 8)));
  const symbolsLabel = document.createElement('label');
  symbolsLabel.textContent = L('Allowed symbols (empty = none)', '可用符号（留空为无符号）');
  const symbols = document.createElement('input');
  symbols.type = 'text'; symbols.maxLength = 32;
  symbols.value = passwordOverrides.allowedSymbols ?? requirements.allowedSymbols ?? '!@#$%^&*_=+?';
  const apply = document.createElement('button');
  apply.type = 'button'; apply.textContent = L('Apply', '应用');
  apply.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const next = { length: Number(length.value), allowedSymbols: symbols.value };
    const result = globalThis.AppleAllInOnePasswordGenerator?.generateCompatiblePassword(requirements, next);
    if (!result?.compatible) {
      showStatus(L('These settings cannot satisfy the website’s rules. Try another length/symbol set; unsupported patterns require manual entry.', '这些设置无法满足网站规则。请调整长度或符号；暂不支持的规则需要手动输入。'));
      return;
    }
    passwordOverrides = next;
    renderState(currentState);
  });
  lengthLabel.appendChild(length); symbolsLabel.appendChild(symbols);
  details.append(summary, lengthLabel, symbolsLabel, apply);
  content.appendChild(details);
  details.addEventListener('toggle', reportHeight);
}

function makeLoginRow(login) {
  const button = document.createElement('button');
  button.className = 'row';
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'row-icon';
  icon.innerHTML = svgKey();
  const main = document.createElement('span');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = login.username || L('(no username)', '(无用户名)');
  const sub = document.createElement('div');
  sub.className = 'row-sub';
  sub.textContent = L('Fill from Apple Passwords', '从 Apple 密码填充');
  main.append(title, sub);
  button.append(icon, main);
  button.insertAdjacentHTML('beforeend', svgChevron());
  button.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    clearStatus();
    send('fill-login', { username: login.username || '' }, e, button);
  });
  return button;
}

function svgCode() { return symbolSvg('code'); }

function makeOtpRow(item) {
  const button = document.createElement('button');
  button.className = 'row';
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'row-icon';
  icon.innerHTML = svgCode();
  const main = document.createElement('span');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = item.username || L('Verification Code', '验证码');
  const sub = document.createElement('div');
  sub.className = 'row-sub';
  sub.textContent = item.domain ? `${L('Fill verification code for', '填充验证码：')} ${item.domain}` : L('Fill verification code from Apple Passwords', '从 Apple 密码填充验证码');
  main.append(title, sub);
  button.append(icon, main);
  button.insertAdjacentHTML('beforeend', svgChevron());
  button.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    clearStatus();
    send('fill-otp', { username: item.username || '' }, e, button);
  });
  return button;
}

function makeGeneratorRow(label, password) {
  const button = document.createElement('button');
  button.className = 'row';
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'row-icon';
  icon.innerHTML = symbolSvg('sparkles');
  const main = document.createElement('span');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = label;
  const sub = document.createElement('div');
  sub.className = 'password-preview';
  sub.textContent = password;
  main.append(title, sub);
  button.append(icon, main);
  button.insertAdjacentHTML('beforeend', svgChevron());
  button.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    send('generate-password', { password }, e, button);
  });
  return button;
}

function renderLocked(state) {
  content.textContent = '';
  if (pinMode) return renderPin();
  const wrap = document.createElement('div');
  wrap.className = 'unlock';
  wrap.innerHTML = `<div class="unlock-icon">${svgKey()}</div>`;
  const title = document.createElement('div');
  title.className = 'unlock-title';
  title.textContent = L('Apple Passwords is locked', 'Apple 密码已锁定');
  const copy = document.createElement('div');
  copy.className = 'unlock-copy';
  copy.textContent = state.canUnlock ? L('Unlock once to use passwords and verification codes from iCloud Keychain in this browser.', '解锁一次即可在此浏览器中使用 iCloud 钥匙串中的密码和验证码。') : L('Unlock from the toolbar to fill passwords in this embedded sign-in frame.', '请从工具栏解锁，然后在此嵌入式登录框中填充密码。');
  wrap.append(title, copy);
  if (state.canUnlock) {
    const button = document.createElement('button');
    button.className = 'primary';
    button.type = 'button';
    button.textContent = L('Unlock', '解锁');
    button.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      button.disabled = true;
      button.textContent = L('Requesting…', '正在请求…');
      send('request-unlock', {}, e, button);
    });
    wrap.appendChild(button);
  }
  content.appendChild(wrap);
}

function renderPin() {
  content.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'pin-wrap';
  const label = document.createElement('p');
  label.className = 'pin-label';
  label.textContent = L('Enter the 6-digit code shown by macOS.', '请输入 macOS 显示的 6 位验证码。');
  const input = document.createElement('input');
  input.className = 'pin';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.maxLength = 6;
  input.placeholder = '••••••';
  input.setAttribute('aria-label', L('6-digit Apple Passwords code', 'Apple 密码 6 位验证码'));
  input.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    clearStatus();
    if (input.value.length === 6) {
      input.disabled = true;
      send('verify-pin', { pin: input.value }, e, input);
    }
  });
  const actions = document.createElement('div');
  actions.className = 'pin-actions';
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'link';
  again.textContent = L('Request New Code', '获取新验证码');
  again.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    input.value = '';
    input.disabled = false;
    clearStatus();
    send('new-code', {}, e, again);
  });
  actions.appendChild(again);
  wrap.append(label, input, actions);
  content.appendChild(wrap);
  setTimeout(() => input.focus(), 0);
}

function appendGenerators(pendingPassword = '', requirements = {}) {
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = pendingPassword ? L('Prepared Signup Password', '已准备的注册密码') : L('Suggested Password', '建议密码');
  content.appendChild(label);
  if (pendingPassword) {
    content.appendChild(makeGeneratorRow(L('Use Prepared Password', '使用已准备密码'), pendingPassword));
    return;
  }
  const strong = generateCompatiblePassword(requirements, true);
  const alphanumeric = generateCompatiblePassword(requirements, false);
  if (strong.password) {
    content.appendChild(makeGeneratorRow(strong.adapted ? L('Compatible Strong Password', '兼容此网站的强密码') : L('Strong Password', '强密码'), strong.password));
  }
  if (alphanumeric.password && (!strong.password || /[^A-Za-z0-9]/.test(strong.password))) {
    content.appendChild(makeGeneratorRow(L('Without Symbols', '不含符号'), alphanumeric.password));
  }
  if (!strong.password && !alphanumeric.password) {
    const empty = document.createElement('div');
    empty.className = 'empty error';
    empty.textContent = L('This website’s declared password rules could not be satisfied safely.', '无法安全满足此网站声明的密码规则。');
    content.appendChild(empty);
  }
  appendPasswordControls(requirements);
}

function renderState(state) {
  currentState = state;
  applyStaticLocale();
  pinMode = false;
  clearStatus();
  hostLabel.textContent = safeHost(state.host);
  content.textContent = '';
  if (state.locked) {
    renderLocked(state);
    reportHeight();
    return;
  }
  if (state.mode === 'otp') {
    if (state.lookupError) {
      const error = document.createElement('div');
      error.className = 'empty error';
      error.textContent = state.lookupError;
      content.appendChild(error);
      reportHeight();
      return;
    }
    if (state.otpItems?.length) {
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = state.otpItems.length === 1 ? L('Verification Code', '验证码') : L('Verification Codes', '验证码');
      content.appendChild(label);
      for (const item of state.otpItems) content.appendChild(makeOtpRow(item));
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = L('No verification code saved for this website.', '此网站没有已保存的验证码。');
      content.appendChild(empty);
    }
    reportHeight();
    return;
  }
  // A saved credential is the primary action for a sign-in field. Do not mix in
  // signup, alias, Apple sign-in, or password-generation actions once one exists.
  if (state.logins?.length) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = state.logins.length === 1 ? L('Saved Login', '已保存的登录') : L('Saved Logins', '已保存的登录');
    content.appendChild(label);
    for (const login of state.logins) content.appendChild(makeLoginRow(login));
    reportHeight();
    return;
  }

  let hasSection = appendSmartSignup(state);
  if (state.lookupError) {
    const error = document.createElement('div');
    error.className = 'empty error';
    error.textContent = state.lookupError;
    content.appendChild(error);
    hasSection = true;
  }
  if (state.canGenerate) {
    if (hasSection) { const div = document.createElement('div'); div.className = 'divider'; content.appendChild(div); }
    appendGenerators(state.pendingPassword || '', state.passwordRequirements || {});
    hasSection = true;
  }
  if (!hasSection) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = L('No saved passwords for this website.', '此网站没有已保存的密码。');
    content.appendChild(empty);
  }
  reportHeight();
}

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'openpasswords-port') return;
  if (event.data.secret !== secret || !event.ports?.[0] || port) return;
  port = event.ports[0];
  port.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'state') renderState(msg);
    else if (msg.type === 'error') { finishSignupOperation(); showStatus(msg.message); }
    else if (msg.type === 'operation-finished') finishSignupOperation();
    else if (msg.type === 'pin-ready') {
      pinMode = true;
      clearStatus();
      renderPin();
      reportHeight();
    } else if (msg.type === 'pin-error') {
      pinMode = true;
      renderPin();
      showStatus(msg.message);
    }
  };
  port.start?.();
  reportHeight();
}, { once: false });

closeBtn.addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  send('close', {}, e, closeBtn);
});

window.parent.postMessage({ type: 'openpasswords-inline-ready' }, '*');
