# Third-party notices and source lineage

This repository combines independently licensed open-source projects with later Apple All-In-One contributions. The notices below identify the source lineage; they do not imply that either upstream project or Apple endorses this repository.

## License map

| Material                                                                                                                                     | Upstream                                                                                                                | License    | Retained notice                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------- |
| Apple Passwords native integration, encrypted protocol, password flows, passkey components, OTP-field exclusion, and original inline chooser | [ManiForoughi2/open-passwords](https://github.com/ManiForoughi2/open-passwords)                                         | Apache-2.0 | `LICENSE` and `OPEN_PASSWORDS_NOTICE` |
| Original Hide My Email extension foundation and private iCloud Hide My Email web-service integration                                         | [dedoussis/icloud-hide-my-email-browser-extension](https://github.com/dedoussis/icloud-hide-my-email-browser-extension) | MIT        | `LICENSES/Hide-My-Email-MIT.txt`      |
| Original code and modifications first authored for Apple All-In-One                                                                          | This repository                                                                                                         | Apache-2.0 | `LICENSE`, `NOTICE`, `LICENSING.md`   |

## Open Passwords

Source lineage includes code that Open Passwords documents as ported from `au2001/icloud-passwords-firefox`. The complete Apache License 2.0 text is retained at `LICENSE`; the NOTICE supplied by Open Passwords is retained at `OPEN_PASSWORDS_NOTICE`.

Apple All-In-One has modified and extended the upstream password integration. Stored verification-code discovery, on-demand code retrieval, popup and inline suggestions, origin-checked filling, exact-host prioritization, unified popup details, reliability work, localization, and integration with the Hide My Email feature set are project additions. They should not be attributed to the upstream Open Passwords project.

## iCloud Hide My Email Browser Extension

Source lineage: `dedoussis/icloud-hide-my-email-browser-extension`.

Copyright (c) 2022-2024 Dimitrios Dedoussis.

The original MIT permission notice is retained in full at `LICENSES/Hide-My-Email-MIT.txt`.

Apple All-In-One has substantially redesigned and extended this component, including the unified manager, cache behavior, website identity, recent-mail activity and previews, direct deletion, bulk actions, Smart Signup, localization, and shared popup/background integration.

## Scope and independence

The repository's open-source licenses cover repository code only. They do not grant rights in Apple trademarks, icons, software, services, native helpers, private interfaces, extension identity, patents, accounts, or distribution channels.

This project is independent and is not endorsed by, affiliated with, maintained by, authorized by, or sponsored by Apple Inc.
