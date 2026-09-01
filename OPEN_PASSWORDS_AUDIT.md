# Security design notes

## Threats addressed

### 1. Page reads credential UI
Upstream rendered account names, PIN input, and generated-password previews as ordinary elements under `document.body`. A page script could enumerate or mutate them.

**Change:** the only page-visible node is a style-pinned host with a **closed Shadow DOM**. The actual UI is a `chrome-extension://` iframe. Credential UI strings are never written into the page DOM.

### 2. Page triggers a vault lookup with scripted focus
A page can call `.focus()` itself. Browser-generated focus events are not a sufficient authorization signal for password enumeration.

**Change:** a login-field focus is eligible only within 1.2 seconds of a trusted pointer or keyboard event. Script-only focus does not call `inlineLogins`.

### 3. Page sends fake UI commands
`window.postMessage` alone is not a safe channel because the page shares the parent window.

**Change:** the extension iframe emits only a non-sensitive ready event. The content script verifies the sender window + extension origin, then transfers a private `MessagePort`. A 128-bit random secret in the iframe URL fragment authenticates the port bootstrap. Sensitive UI traffic stays on that port.

### 4. Extension iframe origin
This client must deliberately retain Apple's accepted Chrome extension ID to reach `PasswordManagerBrowserExtensionHelper`. Because that ID is already fixed and public, `use_dynamic_url` provides little practical fingerprinting benefit here and can complicate extension-frame origin checks across Chromium variants.

**Change in 0.51:** the isolated iframe uses the normal extension origin. The content script still authenticates it by checking `event.source`, the exact extension origin, and a per-instance random secret before transferring the private `MessagePort`.

### 5. Page moves/overlays the password chooser
Any in-page UI can be targeted by CSS/DOM manipulation.

**Change:** the host is pinned with inline `!important`; each privileged action checks the host rectangle, computed visibility/pointer state, and `elementFromPoint()` immediately before fill/unlock/generation. A second navigation of the protected iframe destroys the UI. The host is hidden until the authenticated iframe handshake finishes.

**0.51 fix:** the earlier MutationObserver-based self-repair was removed because an asynchronous observer can react to the extension's own style writes and create a page-freezing mutation loop. Security does not depend on continuous self-repair: any tampering causes the action-time validation to fail and the chooser closes.

### 6. Generated password preview leaks before selection
The page should not learn a suggested password until the user actually selects it and it is filled into the site's password field.

**Change:** generation and preview happen inside the extension iframe. Only the selected password is sent over the private port to the isolated content script.

## Unavoidable boundary

After a password is intentionally filled into a website's own input element, JavaScript running on that origin can generally observe the field value. That is inherent to browser autofill and cannot be hidden from the destination site while still logging the user in.

## Protocol layer

The SRP-6a and AES-GCM primitives remain unchanged. 0.52 extends `protocol.js` with Apple helper commands 15/16/17 for website verification codes; the OTP query payload is encrypted through the same established secret session.

## Verification performed here

- JSON validation for the new manifest.
- `node --check` for `content.js`, `inline.js`, and `popup.js`.
- Extension-ID derivation from the retained manifest public key verifies `pejdijmoenmkgeppbflobdenhhabjlaj`.
- Static assertions verify PIN UI and generated-password preview markup are absent from `content.js`.
- Regression assertions verify there is no `MutationObserver` in the content UI and the hit-testable host uses `pointer-events:auto`.
- No new network client (`fetch`, XHR, WebSocket, beacon) was added.

A real end-to-end native-helper test still requires macOS 14+ with Apple Passwords/iCloud Keychain and `PasswordManagerBrowserExtensionHelper` available.


## Verification-code handling

- OTP metadata (`cmd 16`, `GHOST_SEARCH`) is queried only after a recent trusted user gesture focuses a recognized OTP field.
- The live code (`cmd 17`, `SEARCH`) is fetched only after a trusted click inside the extension-origin iframe.
- The live code is never written to `chrome.storage`, never put in the page-side suggestion DOM, and never cached in the background worker.
- Background sends the code only to the exact tab/frame that requested it; content script re-checks the host before inserting it.
- Split OTP widgets are filled locally in the target frame one character at a time.
