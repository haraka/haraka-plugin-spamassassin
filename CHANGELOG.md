# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/).

### Unreleased

### [1.1.1] - 2026-06-20

#### Fixed

- fix(spamd_socket): support `[ipv6]:port` via net_utils.endpoint #7
- deps(dev): bump haraka-test-fixtures to ^1.7.0
- refactor: rename hook_data_post to spamassassin_data_post
- split into reusable `parse_spamassassin` + `handle_spamassassin`
  related to haraka/Haraka#3604

### [1.1.0] - 2026-05-17

- changed: dep address-rfc2821 -> @haraka/email-address
- changed: bumped all dep versions to latest

### [1.0.4] - 2026-05-10

- fix: cleanup message pipe if spamd errors
- ci: updated configs
- deps: bumped all versions to latest

### [1.0.3] - 2025-02-06

- results: tidying up duplicate data
- results.hits: deleted, alias for score
- results.status: deleted, alias for flag
- results.flag: change from Yes/No to boolean

### [1.0.2] - 2025-01-26

- prettier: move config into package.json

### [1.0.1] - 2025-01-09

- dep(eslint): update to v9

### [1.0.0] - 2024-05-07

- repackaged from haraka/Haraka

[1.0.1]: https://github.com/haraka/haraka-plugin-spamassassin/releases/tag/1.0.1
[1.0.2]: https://github.com/haraka/haraka-plugin-spamassassin/releases/tag/v1.0.2
[1.0.0]: https://github.com/haraka/haraka-plugin-spamassassin/releases/tag/1.0.0
[1.0.3]: https://github.com/haraka/haraka-plugin-spamassassin/releases/tag/v1.0.3
[1.0.4]: https://github.com/haraka/haraka-plugin-spamassassin/releases/tag/v1.0.4
[1.1.0]: https://github.com/haraka/haraka-plugin-spamassassin/releases/tag/v1.1.0
[1.1.1]: https://github.com/haraka/haraka-plugin-spamassassin/releases/tag/v1.1.1
