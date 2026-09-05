// Local-only visual QA. Serves the real production popup/inline bundles with
// synthetic data. All non-local fetches are intercepted; no Apple account used.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../build');
const mocks = readFileSync(
  new URL('./fixtures/preview-mocks.js', import.meta.url),
  'utf8'
);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/icons-preview.html') {
    const icons = JSON.parse(readFileSync(new URL('../src/icons/symbols.json', import.meta.url), 'utf8'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Shared symbol catalog</title><link rel="stylesheet" href="/src/apple-design.css"><script>${mocks}</script><style>body{padding:28px;background:var(--apple-bg);color:var(--apple-label)}h1{font-size:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:12px;max-width:780px}figure{display:flex;flex-direction:column;align-items:center;gap:14px;padding:20px 10px;margin:0;background:var(--apple-surface);border-radius:18px}figcaption{font:11px system-ui;color:var(--apple-secondary)}figure div{display:flex;align-items:center;gap:16px;color:var(--apple-blue)}</style></head><body><h1>Shared symbol catalog</h1><p>Original vector drawings · 18 pt / 32 pt</p><main>${Object.entries(icons).map(([name, paths]) => `<figure><div>${[18,32].map((size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`).join('')}</div><figcaption>${name}</figcaption></figure>`).join('')}</main></body></html>`);
    return;
  }
  if (url.pathname === '/form-preview.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Production content-script QA</title><script>${mocks}</script><style>body{font:15px system-ui;max-width:440px;margin:30px;background:#f2f4f8}label{display:block;margin:18px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:5px;border:1px solid #aaa;border-radius:8px}output{display:block;margin:16px 0;padding:12px;background:#fff}</style></head><body><h1>Change password — synthetic QA</h1><p>No account or network writes. Tests the real production content script.</p><form><label>Current password<input id="current-password" type="password" autocomplete="current-password"></label><label>New password<input id="new-password" type="password" autocomplete="new-password" minlength="12" maxlength="16" pattern="[A-Za-z0-9.]{12,16}" aria-describedby="rules"></label><p id="rules">12–16 characters. Allowed symbols: .</p><label>Confirm new password<input id="confirm-password" type="password" autocomplete="new-password" minlength="12" maxlength="16" pattern="[A-Za-z0-9.]{12,16}"></label></form><form><label>Unrelated password<input id="unrelated" type="password"></label></form><output id="qa-result">Not filled yet</output><script>
      document.addEventListener('input',()=>{const old=document.querySelector('#current-password'),next=document.querySelector('#new-password'),confirm=document.querySelector('#confirm-password'),unrelated=document.querySelector('#unrelated');document.querySelector('#qa-result').textContent=JSON.stringify({currentUntouched:old.value==='',confirmationMatches:!!next.value&&next.value===confirm.value,unrelatedUntouched:unrelated.value==='',length:next.value.length,valid:next.validity.valid,symbolsValid:/^[A-Za-z0-9.]*$/.test(next.value)});});
    </script><script src="/passwordsContent.bundle.js"></script></body></html>`);
    return;
  }
  if (url.pathname === '/inline-preview.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><meta charset="utf-8"><title>Inline chooser QA</title><style>body{background:#e7e9ee;font:14px system-ui;padding:24px}iframe{width:420px;height:540px;border:0;border-radius:16px}button{margin:8px;padding:8px}</style><h1>Synthetic inline chooser</h1><button id="signup">Signup</button><button id="generator">Password field</button><p id="result">No requests yet</p><iframe src="/src/inline.html#qa-secret"></iframe><script>
      const iframe=document.querySelector('iframe');let port;let mode='signup';let requests=0;
      function state(){port?.postMessage({type:'state',mode:'passwords',host:'example.test',language:'en',logins:[],locked:false,canGenerate:mode==='generator',canSmartSignup:mode==='signup',passwordRequirements:{minLength:8,maxLength:16},canUnlock:false});}
      document.querySelector('#signup').onclick=()=>{mode='signup';state()};document.querySelector('#generator').onclick=()=>{mode='generator';state()};
      window.addEventListener('message',e=>{if(e.source!==iframe.contentWindow||e.data?.type!=='openpasswords-inline-ready')return;const channel=new MessageChannel();port=channel.port1;port.onmessage=e=>{if(e.data?.type==='resize')iframe.style.height=e.data.height+'px';else{document.querySelector('#result').textContent='Requests: '+(++requests)+'; action: '+e.data.type;port.postMessage({type:'error',message:'Synthetic offline response: retry is available.'});port.postMessage({type:'operation-finished'});}};iframe.contentWindow.postMessage({type:'openpasswords-port',secret:'qa-secret'},location.origin,[channel.port2]);state();});
    </script>`);
    return;
  }
  const filename = path.resolve(root, '.' + url.pathname);
  if (
    !filename.startsWith(root + path.sep) ||
    !/\.(html|js|css|png|svg|json)$/.test(filename)
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const content = readFileSync(filename);
    const ext = path.extname(filename);
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
      }[ext]
    );
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      ['/popup.html', '/options.html', '/userguide.html'].includes(url.pathname)
        ? content
            .toString()
            .replace('<head>', `<head><script>${mocks}</script>`)
        : content
    );
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(4179, '127.0.0.1', () =>
  console.log('Synthetic extension preview: http://127.0.0.1:4179/popup.html')
);
