<p align="right">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

> **v1.2.6.1:** TypeScript hotfix for the automatic Apple Passwords connection flow. The popup state variable is explicitly typed as the full PasswordState union so a valid `unlocked` response from the native helper no longer fails typecheck/build.

> **v1.2.6:** Toolbar startup is isolated behind a small bootstrap that repairs global/per-tab action state, while opening the popup can automatically begin the Apple Passwords access-code flow.

# Apple All-In-One v1.2.13

**Apple All-In-One** is an independent Chromium extension that brings several Apple account features into one place: Apple Passwords, passkeys, verification codes, and iCloud+ Hide My Email.

It combines the user-tested **Open Passwords** codebase with the redesigned **Hide My Email** codebase while preserving separate security boundaries for native password access and iCloud web services.

> Independent open-source project. Not endorsed by, sponsored by, or affiliated with Apple Inc. Apple, iCloud, iCloud+, and related product names are trademarks of Apple Inc.

**Project repository:** https://github.com/chatgptuk/apple-all-in-one-extension

## Project origins / upstream projects

Apple All-In-One is primarily derived from two open-source projects:

1. **Open Passwords** — https://github.com/ManiForoughi2/open-passwords
   Provides the Apple Passwords integration layer, including macOS native messaging, SRP/AES-GCM session handling, password lookup and save flows, passkey-related components, OTP-field exclusion, and the secure inline credential chooser. Apple All-In-One adds stored verification-code discovery, on-demand code retrieval, suggestions, and origin-checked filling; those OTP-management features are not supplied by Open Passwords. This project retains the relevant Apache-2.0 notices and upstream attribution.

2. **iCloud Hide My Email Browser Extension** — https://github.com/dedoussis/icloud-hide-my-email-browser-extension
   Provides the original browser-extension foundation and private iCloud Hide My Email API integration. Apple All-In-One extends it with the redesigned alias manager, explicit create/use flow, website identity and favicon display, recent iCloud Mail activity, direct delete, and bulk management. The original MIT license and copyright notice are retained.

See `LICENSES/`, `THIRD_PARTY_NOTICES.md`, and `OPEN_PASSWORDS_NOTICE` for licensing details.

## Included features

- Apple Passwords through the macOS `com.apple.passwordmanager` native helper.
- SRP session establishment and encrypted credential reads/writes.
- Password filling and password-save/update flows.
- Apple Passwords verification-code discovery, on-demand retrieval, chooser/popup suggestions, and secure filling implemented by Apple All-In-One.
- OTP-field exclusion, the passkey bridge, and optional conditional-passkey suppression retained from Open Passwords.
- iCloud+ Hide My Email address generation, reserve and form filling.
- Alias search and management.
- Direct deletion of active aliases (`deactivate → delete` automatically).
- Multi-select bulk deactivate and bulk delete with sequential execution.
- Website/domain identification and favicon display for aliases.
- Recent iCloud Mail activity (`Last received …`) with a 24-hour automatic cache and bounded Inbox scan. Manual refresh still forces an immediate scan.
- One secure inline chooser for saved credentials, verification codes, and optional Hide My Email creation.
- Apple-style popup, settings, guide, and code-drawn cloud/keyhole application icon.
- English and Simplified Chinese UI. Default language follows the browser; Settings can override it with Chinese or English.
- Lazy startup: installation and browser startup do not validate iCloud or connect to the Apple Passwords native helper. Those services initialize only when their feature is actually used.
- Popup background-message retry for short MV3 service-worker wake-up races.

## Startup behavior

Apple All-In-One intentionally keeps installation and browser startup lightweight:

- `onInstalled` does not validate the iCloud web session.
- `onInstalled` / `onStartup` do not open the Apple Passwords native connection.
- The toolbar action is kept globally enabled without per-tab `setPopup` or enable/disable state.
- Apple Passwords connects to `com.apple.passwordmanager` only when Passwords is actually requested.
- Hide My Email validates/discovers the iCloud session only when Hide My Email is opened or an HME action is explicitly used.
- **Automatically Reconnect Hide My Email** is on by default. Opening Hide My Email or detecting an expired cached session triggers one bounded re-check of the browser's existing trusted iCloud web session. If Apple requires fresh authentication, the extension stops and shows an iCloud.com sign-in action; the behavior can be disabled in Settings.
- Popup messages retry briefly when Chromium is still waking the MV3 service worker.

This is intended to avoid the post-install period where the toolbar icon appeared responsive only from extension pages.

## Language

The extension ships with English and Simplified Chinese UI.

- Default: **Follow Browser** (`chrome.i18n.getUILanguage()`).
- Manual choices: **中文** or **English** in Settings → General → Language.
- Popup, Settings, Setup Guide, secure inline chooser, HME context-menu copy, and notifications use the selected language.
- The manifest also includes Chrome `_locales` metadata so the extension description follows the browser language.

## Important interaction behavior

Focusing an email field **does not generate a Hide My Email address**.

The flow is intentionally explicit:

1. Focus an eligible email/login field.
2. Choose **Create Private Address**.
3. The extension requests a candidate HME address.
4. Choose **Use** to reserve it and fill the field.

This prevents unused aliases from being created simply because a page contains an email input.

## Install / upgrade from Open Passwords

Apple All-In-One intentionally preserves the Open Passwords manifest `key`, so Chromium generates the same extension ID expected by the existing native-policy helper.

1. Install dependencies and build the project.
2. Open `chrome://extensions`.
3. Remove or unload the previous unpacked Open Passwords build; Chromium cannot load two unpacked extensions with the same fixed ID.
4. Load the generated `build/` directory.
5. If Open Passwords already worked on this browser, the existing native helper configuration should continue to match the preserved extension ID.
6. If the helper has never been installed, run `native/install.sh`, fully quit Chrome, and reopen it.
7. Disable/remove the old standalone Hide My Email extension after confirming the unified extension works.

## Build

Requires Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm run build
```

Then load `build/` as an unpacked extension from `chrome://extensions`.

Development watch mode:

```bash
npm run watch
```

The dependency set intentionally avoids `webpack-dev-server`, `sockjs`, and the deprecated `uuid@8` dependency chain that caused previous npm audit warnings.

## Apple Passwords security model

The Passwords subsystem keeps the Open Passwords architecture:

- Native connection: `com.apple.passwordmanager`
- SRP handshake using the macOS six-digit challenge
- AES-GCM protected native query channel
- Decrypted password cache held in service-worker memory only and cleared on session lock/state loss
- Privileged popup/background message validation
- Frame/origin checks for credential fills

The fixed extension identity is preserved because the macOS native helper/policy authorization depends on it.

## Hide My Email security model

Hide My Email does **not** receive the Apple Passwords native session keys or decrypted password values.

It uses the already-authenticated iCloud.com browser session for private iCloud web-service calls. The extension does not ask the user to type their Apple Account password into the extension.

Apple All-In-One does not attempt to read an Apple Account password from Keychain and silently recreate an iCloud web login. Apple Passwords native access provides credential operations, not a supported resumable iCloud web-auth session; iCloud sign-in may also require Apple authentication/2FA/trust state.

Mail activity scans recent `INBOX` threads only. Spam/Junk/Trash are not scanned. Cached historical last-received timestamps remain available even when a previously matched email is later moved or deleted.

Recent mail activity is available only when Hide My Email forwards to iCloud Mail (`@icloud.com`, `@me.com`, or `@mac.com`).

## Hide My Email management

The address manager supports:

- Search by label, alias, note, or detected website.
- Copy address.
- Activate / deactivate.
- Direct delete of an active alias by automatically performing `deactivate → delete`.
- Multi-select mode.
- Bulk deactivate.
- Bulk delete.
- Partial-failure handling: failed addresses remain selected for retry.
- Website favicons when Chrome can resolve them, with safe fallbacks.
- Cached recent mail activity.

## Browser notes

Apple Passwords native-helper integration is designed for Chromium browsers on macOS. The Hide My Email portion can also be built for Firefox, but the Apple Passwords native-helper behavior is Chromium/macOS-specific.

## Licenses

This repository contains code under more than one license.

- Open Passwords and related ported components: Apache License 2.0 notices retained.
- Original Hide My Email browser extension: MIT License and original copyright notice retained.

See:

- `LICENSES/Open-Passwords-APACHE-2.0.txt`
- `LICENSES/Hide-My-Email-MIT.txt`
- `OPEN_PASSWORDS_NOTICE`
- `THIRD_PARTY_NOTICES.md`


### v1.2.8 interaction polish

The Apple Passwords access-code field in the toolbar popup automatically verifies when six digits are entered or pasted, so the normal unlock flow no longer requires pressing **Unlock**.


### v1.2.9 deterministic site-icon fallback

- Rejects date-like/numeric HME labels such as `2025.6.30` as website domains.
- A monogram is rendered immediately and remains underneath any verified favicon, so async loading can never produce an empty tile.
- Removes Chrome `_favicon` as the final resolver fallback because Chrome may return a valid generic globe when no site favicon exists.
- Adds conventional `favicon.png` and `favicon.svg` candidates.
- Unresolved website icons now remain deterministic monograms across list and detail views.

### v1.2.13 Chromium favicon repair

- Supersedes the v1.2.9 direct favicon-candidate strategy above; that entry is retained as release history.
- Uses Chromium's Manifest V3 `_favicon` API instead of downloading website HTML or guessing remote `/favicon.*` paths.
- Supports icons declared on CDN or hashed asset URLs through Chromium's favicon store.
- Filters Chromium's generic globe response so unresolved websites still keep deterministic monograms.
- Avoids third-party CSS/font preload warnings being attributed to `popup.html`.
