# Native helper exit investigation (2026-09-19)

## Confirmed evidence

- The v1.3.8 diagnostic report recorded `unlocked` at 1789880799698 and
  `helper_exited` at 1789881005553 (about 206 seconds later).
- The worker start did not change. No metadata/secret timeout or explicit Apple
  relogin event was recorded in that interval.
- A local macOS crash report for `PasswordManagerBrowserExtensionHelper` matches
  that exit to within 100 ms. The system exception log at 22:10:05.552 PDT says
  `NSInvalidArgumentException`, `stringByAppendingString:`, `nil argument`.
- Nine helper crash reports from September 15–19 share the same stack. This is
  repeated native-process failure, not merely a browser-worker idle timeout.
- The inspected macOS 27.0 (26A428) helper binary has matching arm64e UUID
  `E5713284-A0ED-37FC-BEC8-2817AD32C1BB`. Static inspection of the crash offsets
  shows a password query reading `domain`, falling back to `updatedDomain` when
  empty, and appending that value without a nil check. The query model reads
  those strings from `URL` and `NURL`. The stack passes through
  `_handleGetLoginNamesForURL:completionHandler:`.

No helper was launched, authentication bypassed, password retrieved, or native
binary modified during this investigation. Original crash reports and system
logs are not included in the repository.

## Confirmed extension gap and v1.3.9 prevention

The former lookup accepted any URL and extracted `new URL(url).hostname`.
`about:blank`, `file:`, `data:` and `blob:` can therefore produce an empty
`URL` without `NURL`. Internal pages such as `chrome://newtab/` also reached
the website-query protocol. This input gap was reproduced with a synthetic
transport, without sending invalid data to Apple's helper.

- Validate HTTP/HTTPS, nonempty hostname and a real tab ID at every public native
  website-query/save entry point; repeat validation before background metadata
  requests can connect to the helper.
- Independently reject missing, blank or mismatched password-query `URL` before
  encryption, preserving the existing authenticated session.
- Keep HTTP/IP/localhost/IPv6/IDN support; this does not change HTTP-fill settings.
- On native exit, record the pending command and the last command sent on that
  port. Individual requests are not journaled: the 40-entry history must keep
  the unlock and exit timestamps that this investigation relied on.
- Distinguish an unexpected helper exit from an ordinary locked session in errors.

## Still unproven

The user reports the failure occurred on an ordinary website. Version 1.3.8 did
not retain its target or the in-flight command. We cannot establish that an
unsupported-page lookup caused this particular exit. A transient tab/frame URL
is a hypothesis, not a confirmed explanation.

The inspected normal HTTP/HTTPS login-query path always constructs a nonempty
`URL`. Synthetic encryption/concurrency tests do not substitute for the user's
real Chrome/macOS session. v1.3.9 blocks the confirmed invalid-input class; it
must not be described as proving all helper crashes eliminated. Actual helper
death invalidates its in-memory authentication state; a new unlock is still
required, without persisting or replaying PINs/SRP keys.
