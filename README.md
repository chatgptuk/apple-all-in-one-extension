<p align="right">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

# Apple All-In-One

An independent, open-source Chromium extension that brings Apple Passwords, passkeys, verification codes, and iCloud+ Hide My Email into one interface.

> [!IMPORTANT]
> **This is currently a macOS/Chromium sideloading project, not a Chrome Web Store-ready product.** The Apple Passwords integration retains the public manifest key used by Apple's own extension so that macOS's fixed native-helper allowlist recognizes it. This produces the same extension ID, means the official Apple extension cannot be enabled at the same time, and does not grant permission to publish or impersonate Apple's extension.

This project is not endorsed by, sponsored by, authorized by, or affiliated with Apple Inc. Apple, iCloud, iCloud+, Apple Passwords, and related names are Apple trademarks used here only to describe compatibility and the services being accessed.

**Current version:** 1.3.8<br>
**Repository:** https://github.com/chatgptuk/apple-all-in-one-extension

## Who this project is for

Apple All-In-One is suitable for technically experienced users who:

- use a Chromium-based browser on macOS;
- already store credentials and verification codes in Apple Passwords;
- use iCloud+ Hide My Email;
- are comfortable building and loading an unpacked extension; and
- understand that undocumented Apple interfaces can change without notice.

It is not currently suitable for Chrome Web Store submission, managed enterprise deployment, or distribution as an Apple-approved product.

## Features

### Apple Passwords

If the native helper disconnects temporarily, reopen the popup to reconnect. The unavailable-helper screen also offers **Retry Connection**, without reloading the extension. macOS may still require unlocking the new session.

A slow account/code-list query no longer immediately discards the unlocked session: after the 5-second UI timeout, the connection allows up to 25 more seconds to discard its late reply before accepting new requests. A missing reply beyond that limit, or an explicit Apple session reset, still requires reconnecting. Stale unlock controls and duplicate code submissions cannot reset an already unlocked session. **Website Settings & Status → Copy Safe Diagnostic Report** includes bounded connection events and worker-start markers retained in browser session memory across background-worker restarts, without accounts, passwords, codes, URLs or raw native messages. It does not retain or restore authentication keys.

- Connects to the macOS `com.apple.passwordmanager` native helper.
- Uses the Open Passwords SRP/AES-GCM protocol for encrypted credential queries.
- Finds, fills, saves, and updates passwords.
- Generates passwords for supported page length, pattern, character-class, and symbol rules, then validates them before filling. Optional length/symbol controls stay within the site's constraints. Generated passwords never use `-` or overwrite current-password fields.
- Prioritizes credentials whose saved site exactly matches the current hostname, then shows related-domain matches.
- Supports passkey bridging and optional suppression of silent conditional-passkey suggestions.
- Shows saved verification-code entries and fills codes with origin/frame checks.
- Keeps decrypted secrets in extension memory only and clears them when the native session ends.

Clicking a saved login fills the current page and expands its details in the popup. The password remains masked until explicitly revealed. If the account has a verification code, **Show Code** is a separate action because macOS can require a separate Touch ID authorization for that native read. Clicking a standalone verification-code entry fills the page and expands the code details from the same authorized read, without requesting Touch ID twice for that action.

**Details Only** opens either type of entry without changing the page; **Fill Again** remains available in details. Same-account, same-host password reads can reuse a memory-only cache for up to two idle minutes, with a five-minute maximum lifetime. Multiple different secrets for an indistinguishable account are not silently reduced to the first result.

Save feedback distinguishes waiting for unlock, submitted to Apple, failed, and expired. A submitted request still needs confirmation in Apple's system sheet; the private native interface does not confirm the user's final save decision. Deferred saves expire after five minutes.

### iCloud+ Hide My Email

- Creates, reserves, fills, searches, activates, deactivates, and deletes private addresses.
- New addresses default to **Create Address** without filling the page; **Create and Fill** is a separate action. A successfully created address is automatically copied, with a manual retry if copying fails. This uses clipboard-write permission, not clipboard-read permission.
- The candidate address and draft stay in place when the same iCloud session refreshes; only **Generate another address** requests a replacement while this page stays open.
- Edits the label and optional note of an existing private address from its detail view.
- Switches to the previous or next address directly in details, following the filtered and sorted list you opened. Unsaved edits are confirmed before leaving.
- Reuses the address list from a two-minute session cache; stale data is shown immediately while a silent refresh runs.
- Supports direct deletion of active aliases by performing `deactivate → delete`.
- Supports multi-select bulk deactivate/delete with retryable partial failures.
- Shows all addresses in one continuous list, with website/status filters and label/date sorting—no pagination or “show more” step. Search covers the complete cached list; bulk selection explicitly states the number of matching addresses. Website icons still load on demand.
- Opens a dedicated, wider **Address Manager** tab for browsing and editing addresses. It does not read passwords or fill a background webpage.
- Lets you associate exact website hostnames with an address locally. Associations and list preferences are separated by iCloud account and do not modify Apple's website metadata.
- Identifies associated websites and displays Chromium-resolved favicons with deterministic fallbacks.
- Caches the last-received timestamp for 24 hours and allows a manual refresh.
- Reads recent iCloud Mail previews only after the user clicks **Check**. Preview content stays in popup memory and is discarded when the popup closes.
- Detects likely 4–8 digit verification codes locally in recent message subjects/previews.

Hide My Email uses the browser's existing signed-in iCloud.com session. The extension never asks for the Apple Account password and does not share Apple Passwords native-session keys with the iCloud subsystem.

### Inline chooser and signup tools

- Displays exact-site saved logins first.
- When a site already has saved logins, hides unrelated signup suggestions.
- When no saved login exists, **Private Signup** can reuse or explicitly create a Hide My Email address and prepare a strong password.
- Can activate a detected Sign in with Apple control only after the user explicitly chooses it.
- Keeps Hide My Email creation available from the editable-field context menu instead of duplicating it in every chooser.
- Offers exact-site addresses before manually associated or related-site addresses, with a choice when multiple aliases match.
- Allows inline suggestions or just private-signup suggestions to be paused per website; toolbar filling and the right-click menu remain available.

No private address is created merely because an email field receives focus. The user must choose **Create Private Address**, review the candidate, and then choose **Use**.

Password compatibility is based on HTML attributes and field-specific guidance. Unsupported patterns or conflicting requirements produce an explicit warning instead of a supposedly compatible password. Hidden JavaScript or server-side restrictions cannot be predicted, so a site may still reject a generated password.

## Requirements and installation

### Requirements

- macOS 15.4 or newer for the Apple Passwords native-helper integration
- a Chromium-based browser
- Node.js 20 or newer
- an active iCloud+ subscription for Hide My Email
- an authenticated iCloud.com browser session for Hide My Email and recent-mail features

### Build and load

```bash
npm install
npm run typecheck
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Remove or disable the official Apple Passwords extension and any previously loaded Open Passwords build. Chromium cannot load two extensions with the same fixed ID.
4. Choose **Load unpacked** and select this repository's `build/` directory.
5. If the native helper has not been configured before, run `native/install.sh`, quit Chrome completely, and reopen it.
6. After the unified extension works, disable the old standalone Hide My Email extension to avoid duplicate menus and requests.

Development watch mode:

```bash
npm run watch
```

## Startup and session behavior

- Browser startup does not validate iCloud or start the Apple Passwords connection.
- Each subsystem initializes only when the corresponding feature is opened or used.
- The popup briefly retries background messages while Chromium wakes its Manifest V3 service worker.
- The Apple Passwords six-digit pairing code belongs to the current native session. Its connected native-messaging port keeps the worker active; there is no perpetual polling alarm. This cannot guarantee that a real browser/native-session restart will remain unlocked.
- Hide My Email can automatically re-check the existing trusted iCloud browser session. If Apple requires authentication or 2FA, the extension stops and sends the user to iCloud.com; it does not attempt to bypass that requirement.
- **Website Settings & Status** shows the two subsystems separately and provides recovery actions and a diagnostic report containing only version, state, operation names, reason codes, and timestamps—not accounts, secrets, or page URLs. iCloud status reflects the locally known session, not a fresh server check.
- Password and verification-code filling is allowed on HTTP pages by default. To block it for one hostname, turn off **Website Settings & Status → Allow filling on HTTP pages**. This covers all ports on that exact hostname, not its subdomains, and does not block HTTPS. HTTP is unencrypted and can expose passwords and codes to interception; Touch ID and document/field checks still apply. This setting does not change the existing HTTPS requirement for saving passwords (except local development sites).

## Language

The popup, Settings, setup guide, inline chooser, context-menu copy, notifications, and manifest description support English and Simplified Chinese.

- Default: **Follow Browser** (`chrome.i18n.getUILanguage()`).
- The globe button in the main popup switches language immediately.
- The same preference is available in **Settings → General → Language**.

## Security and privacy model

### Passwords boundary

- Native connection: `com.apple.passwordmanager`
- SRP challenge followed by an AES-GCM protected query channel
- privileged popup/background message validation
- frame and origin checks before filling
- plaintext credential/cache lifetime limited to extension memory and native-session state

### iCloud boundary

- uses the browser's existing iCloud.com cookies/session rather than collecting an Apple Account password;
- does not receive password-native-session keys or decrypted Apple Passwords values;
- scans a bounded set of recent Inbox threads only—Spam, Junk, Trash, and deleted mail are not scanned;
- persists historical last-received timestamps, but not message bodies, subjects, previews, or detected codes.

These boundaries reduce data exposure, but they do not turn undocumented Apple protocols into supported public APIs.

## Upstream projects and project-owned work

Apple All-In-One combines two independently licensed upstream projects:

1. [Open Passwords](https://github.com/ManiForoughi2/open-passwords) provides the native Apple Passwords integration, encrypted protocol implementation, credential flows, passkey components, OTP-field exclusion, and the original secure inline chooser. Stored verification-code discovery, on-demand retrieval, popup/chooser suggestions, and verified filling are implemented by Apple All-In-One rather than supplied by upstream Open Passwords.
2. [iCloud Hide My Email Browser Extension](https://github.com/dedoussis/icloud-hide-my-email-browser-extension) provides the original extension foundation and private Hide My Email web-service integration. The redesigned manager, cache behavior, website identity, recent-mail activity/previews, direct deletion, bulk management, Smart Signup, and unified interface are later project work.

## License

Project-authored contributions and Open Passwords-derived code use the Apache License 2.0. Code retained from the iCloud Hide My Email Browser Extension remains under its original MIT License.

See the [licensing map](./LICENSING.md), [Apache-2.0 license](./LICENSE), [MIT license](./LICENSES/Hide-My-Email-MIT.txt), [Open Passwords NOTICE](./OPEN_PASSWORDS_NOTICE), and [third-party notices](./THIRD_PARTY_NOTICES.md).

## Known limitations

- Apple Passwords integration is macOS/Chromium-specific.
- Firefox can build the Hide My Email portion, but does not provide the same Apple Passwords native-helper path.
- The official Apple extension must be disabled while this build uses the same extension ID.
- Native or iCloud behavior can stop working after an Apple or browser update.
- iCloud recent-mail features work only when aliases forward to `@icloud.com`, `@me.com`, or `@mac.com`.

## Development checks

```bash
npm run typecheck
npm test
npm run check:release
npm run prettier:check
```

CI also runs an extension-context browser smoke test with synthetic credentials and a fake native transport. Real macOS helper and Touch ID behavior must still be checked manually; see [validation notes](./tests/VALIDATION.md).

The dependency set intentionally avoids `webpack-dev-server`, `sockjs`, and the deprecated `uuid@8` dependency chain that previously produced audit warnings.
