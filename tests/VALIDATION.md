# Reliability regression checks

Run `npm run typecheck` and `npm test`. The latter builds the production extension before running the tests.

Then run `node utils/check-release.mjs`. It checks matching package/lockfile/source/build/README versions, every manifest asset, packaged HTML references, required notices/licenses, and accidental development maps or private-key/config artifacts. CI uses `npm ci` and retains the validated build as a downloadable artifact; it does not publish or submit a release.

The focused suite executes real production functions/modules against synthetic DOM, native transport and iCloud responses. It covers:

- New/current/confirmation fields, disabled controls, unrelated forms and form-less SPA groups.
- Document/origin/URL/input changes while a secret request is in flight; single-use delivery tokens.
- HTTP content scripts without `crypto.randomUUID`: cryptographic fallback tokens and fresh fill leases.
- Exact account identity for password caching and verification-code selection.
- Active idle/hard expiry and bounded LRU credential retention; memory-only pending-save expiry, safe retries and metadata-only notifications.
- Install/update-only migration recovery with bounded tab/frame injection, rather than all-tab work at every service-worker wake.
- Native timeouts, late replies, disconnect cleanup and optional save acknowledgments.
- Closing a signup chooser during address creation and restoring controls after failures.
- Open-ended and concatenated password patterns, multiple required symbols, explicit allowlists, negated hints and manual settings.
- Offline, 401/403 and 429 behavior through the actual background message handlers.
- Shared cached lists across worker reopens, queued mutations, account invalidation, Retry-After and stale inline reuse.

For visual QA, run `node tests/preview-server.mjs`, then open these URLs in the Codex in-app browser:

- `http://127.0.0.1:4179/popup.html`: real production popup, synthetic accounts and addresses. Check expansion/collapse, metadata saving and the updated list.
- `http://127.0.0.1:4179/inline-preview.html`: real inline chooser. Simulates failed signup requests and permits testing length/symbol controls and retries.
- `http://127.0.0.1:4179/form-preview.html`: real production content script on a change-password form, with current/new/confirmation/unrelated fields and browser-native HTML pattern validation.
- Add `?httpCrypto=1` to the form preview to remove `randomUUID` and reproduce a non-secure page's Crypto API surface (loopback itself is considered trustworthy by browsers).
- `http://127.0.0.1:4179/options.html` and `/userguide.html`: settings and setup pages with the same synthetic account.
- Add `?appearance=light` or `?appearance=dark&lang=zh-CN` to popup/settings previews to inspect both appearances and languages. Production pages follow the system appearance; these query overrides exist only in the preview fixture.
- `http://127.0.0.1:4179/icons-preview.html`: the shared original vector catalog at 18 and 32 points. Main UI and isolated inline UI must use the same paths; site favicons remain unchanged.

Visual smoke check: switch sections; expand/collapse password and OTP details; show the language menu; edit alias metadata; scroll the details; focus controls with the keyboard; check the narrow inline chooser and settings switches. Glass belongs to navigation and controls; content cards must remain readable without transparency. The shared `src/styles/apple-design.css` also handles reduced transparency, higher contrast, reduced motion and forced colors.

The preview only listens on loopback and intercepts non-local fetches. It does not authenticate with Apple, use real passwords, or mutate an iCloud account. Stop the server when finished. Real Touch ID, helper-version differences and live iCloud behavior still require a manual smoke test after reloading the unpacked extension and refreshing existing webpages.

## Real extension-context CI smoke

The separate `extension-context` CI job runs `tests/extension-context-smoke.mjs` using pinned Playwright 1.63.0 in an isolated temporary dependency directory. It loads actual built content scripts and the production password background source in a disposable Chromium profile. A fake native adapter exists **only inside a temporary extension copy**, and nativeMessaging permission is removed from that copy. Production files are not patched. All fixture webpages are loopback-only.

This exercises actual Chromium sender/document/frame metadata, SPA locale rewrites, multi-tab isolation, iframe filling, extension reload plus page refresh, and fail-closed handling for changed origins/documents/fields and replayed fill tokens. It does not exercise SRP, Apple's helper, or Touch ID; those remain covered by protocol unit checks plus manual macOS verification. The CI harness refuses to run unless `CI=true`; local UI verification must use the Codex built-in browser rather than launching another browser. Authoring the harness or passing its syntax check is not evidence that the CI browser run passed.
