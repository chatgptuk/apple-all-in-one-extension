# Apple All-In-One redesign notes

## v1.1 — Apple-style visual unification

- Renamed the unified extension to **Apple All-In-One**.
- Replaced the previous envelope/key brand mark with an original code-drawn cloud + keyhole icon representing Apple account services and protected identity.
- Reduced the purple/blue dual-brand treatment; system blue is now the main interaction accent.
- Popup styling is closer to macOS/iOS grouped controls: neutral system background, subtle hairlines, lighter toolbar controls, flatter cards, and reduced web-style shadows.
- Passwords and Hide My Email remain top-level segmented sections, while New Address / My Addresses stays lightweight secondary navigation.
- Unlock/empty states use a restrained tinted system-blue symbol instead of large gradient hero tiles.
- Settings and User Guide use inset-grouped cards with subtle borders and flatter system-color icon tiles.
- The secure inline chooser now shares the same blue identity treatment while retaining its isolated UI/security behavior.
- README explicitly documents the two major upstream repositories and their contributions.

## Hide My Email v5.x functionality retained

### Website identity
- Uses the HME record's `domain` field where useful and falls back to hostname-like labels/notes.
- Site icons are resolved from the website's own declared icon/manifest assets and conventional favicon paths.
- Unresolved sites use a deterministic monogram; the generic Chrome `_favicon` fallback is intentionally not used.
- Private alias domains (`icloud.com`, `me.com`, `mac.com`) are never mistaken for source websites.

### Recent mail activity
- Uses the authenticated iCloud Mail `mccgateway` service.
- Scans bounded recent Inbox thread digests and message metadata to match `To`, `Cc` or `Bcc` recipients against aliases.
- Stores newest matched timestamps in extension local storage.
- Automatic cache lifetime: **24 hours**. Manual refresh still forces an immediate scan.
- No match is labeled `No recent mail found`, not `Never received`.
- Activity requires forwarding to iCloud Mail (`icloud.com`, `me.com` or `mac.com`).

### Explicit address creation
- Email-field detection is passive.
- Focusing a field does not generate a candidate address.
- Generate runs only after explicit **Create**.
- Reserve/fill runs only after explicit **Use**.

### Direct delete and bulk management
- Active aliases can be deleted in one user action; internally the extension performs `deactivate → delete`.
- Select/Done bulk-management mode supports bulk deactivate and bulk delete.
- Operations execute sequentially to reduce API bursts.
- Partial failures remain selected for retry.

### Session / dependency reliability
- Popup renders from cached state without blocking on iCloud validation.
- Only definitive authentication failures clear cached iCloud state.
- iCloud requests use credentials and timeout handling.
- Removed the old webpack-dev-server/sockjs/uuid@8 dependency chain.

## v1.2.0 — startup reliability, localization and project link

- Removed eager Apple Passwords native-helper connection from extension install/startup.
- Removed install-time iCloud session validation; HME web-session work is now lazy and user-driven.
- Keeps the toolbar action globally enabled while avoiding per-tab action state.
- Popup native-background messages retry short MV3 wake-up races.
- Added English + Simplified Chinese UI with browser-language auto detection and a manual language override.
- Localized Popup, Settings, Setup Guide, secure inline chooser, HME context-menu strings and notifications.
- Added Chrome `_locales/en` and `_locales/zh_CN` metadata.
- Added the main project repository to Settings: https://github.com/chatgptuk/apple-all-in-one-extension


## v1.2.3 startup fix

- Fixed a temporal-dead-zone crash in `src/i18n.ts` (`Cannot access '<minified name>' before initialization`).
- The language resolver now uses a hoisted function declaration before the initial language resolution.
- This prevents the background/popup bundle from aborting during extension startup, restoring toolbar popup behavior on ordinary tabs immediately after installation.
- Build output now treats `package.json` as the authoritative extension version to avoid manifest/package version drift.

## v1.2.3 — iCloud reconnect behavior

- Fixed Hide My Email session discovery so it cannot remain indefinitely in the Checking iCloud state.
- Added an opt-in **Automatically Reconnect Hide My Email** preference (off by default). It only re-checks an existing trusted iCloud web session; it never retrieves or stores an Apple Account password and never bypasses Passkey, Touch ID, 2FA, CAPTCHA, or other Apple confirmation.
- Signed-out state now gives explicit **Open iCloud.com** and **Check Existing Session** actions.
- Storage-backed UI state now listens for external storage changes, allowing a successful iCloud web login captured by the background worker to update open extension pages immediately.

## v1.2.4 — fill recovery and HME defaults

- Hide My Email trusted-session reconnect is now on by default while remaining user-toggleable.
- Fixed the signed-out HME action layout so primary and secondary actions no longer overlap or fall back to browser-default button styling.
- Added explicit-user fill recovery using `chrome.scripting` for tabs that were already open during an unpacked-extension install/reload.
- Added clearer no-target-field errors instead of exposing Chrome's `Receiving end does not exist` transport error.
- Expanded verification-code field recognition for `Authenticator code`, two-factor/MFA labels, and common 4–8 digit numeric code inputs.

## v1.2.5 toolbar startup hardening

- Added a tiny `background-bootstrap.js` service worker that repairs the global action and any stale disabled state on tabs that survived an unpacked-extension reload before loading the heavier background bundle.
- The application background no longer owns `chrome.action` state.
- `Passwords getState` is now side-effect free: opening the toolbar never connects to `com.apple.passwordmanager`.
- Opening the popup never automatically requests a macOS six-digit challenge. Native connection/challenge starts only after an explicit **Unlock Apple Passwords** user click.
- If the macOS challenge temporarily moves focus away and closes the Chrome popup, reopening it reuses the live challenge instead of creating another one.


## v1.2.6.1

- Fixed Popup TypeScript state narrowing in the automatic Apple Passwords connect flow.
- `nextState` is now explicitly typed as `PasswordState`, allowing a valid `unlocked` state returned by the native helper.
- No runtime behavior or permissions changed.

## v1.2.6
- Restored automatic Apple Passwords access-code challenge when the toolbar popup opens.
- Toolbar bootstrap now repairs global and per-tab popup targets as well as enabled state.
- Favicon fallback order prefers real site assets; unresolved entries remain deterministic monograms instead of Chrome's generic globe.


## v1.2.7 website icon resolver
- Website icons are loaded lazily only for visible alias rows.
- The resolver parses each site's declared `<link rel="icon">`, Apple touch icons, and web-app manifest before trying conventional paths.
- Downloaded image bytes are decoded and verified before rendering; broken-image placeholders are never shown.
- Results are cached per domain for the popup lifetime, so repeated aliases (for example AWS) do not trigger repeated requests.
- A monogram is shown immediately and remains as the final fallback.

## v1.2.8

- Apple Passwords 6-digit access-code entry now verifies automatically as soon as all six digits are entered or pasted in the toolbar popup.
- The Unlock button remains as a fallback, but no extra click is required during the normal flow.
- Added an in-flight guard so paste/typing/Enter cannot submit the same access code twice concurrently.
- The secure inline chooser already auto-submitted six-digit access codes; toolbar behavior now matches it.


## v1.2.9 site-icon stability
- Date-like or all-numeric dotted labels are no longer misclassified as website domains.
- Monograms are permanent base layers; verified favicons only overlay them.
- Chrome's generic `_favicon` globe fallback was removed to prevent async icon flicker and nondeterministic fallbacks.


## v1.2.11
- Fixed the Apple access-code fallback button TypeScript handler signature by invoking `verify()` explicitly instead of passing it directly as a React click handler.


## v1.2.12

- Mail activity automatic refresh interval increased from 30 minutes to **24 hours**. Manual refresh still forces a scan immediately.
- Hide My Email context-menu login state now follows `clientState` changes from Popup/session discovery.
- The context-menu action stays enabled while signed out so an explicit user click can re-discover an already trusted iCloud web session.
- Right-click HME generation now refreshes and persists the trusted iCloud session before generating an alias, avoiding stale "Sign in to iCloud" state.
- Corrected the Security & Privacy copy: automatic reconnect never reads or submits the Apple Account password.

## v1.2.13 — Hide My Email context-menu completion

- Right-click Hide My Email now remembers the exact editable element that opened the menu instead of relying on `document.activeElement` after the menu closes.
- The HME content script now runs in all frames, and context-menu replies target the originating frame, so login fields inside iframes can be filled correctly.
- Creating from the context menu no longer writes a temporary “Preparing…” string into the input.
- On success, the reserved alias is filled into the original field and copied when clipboard access is available.
- A small in-page status toast reports preparing, success, session/sign-in errors, or when the original field disappeared before the request finished.
- Existing tabs from before an extension reload get one on-demand content-script reinjection/retry when the context-menu message has no receiver.
