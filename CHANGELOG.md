# Changelog

## 0.1.0-beta.1 - 2026-08-17

- Published under the official `@llamagen/cli` package name.
- Added cookie-backed browser authentication with `auth login`, `auth status`, and `auth logout`.
- Added configurable authentication and Comic API domains for the `next.llamagen.ai` release environment.
- Moved local API credentials into a dedicated mode-0600 credentials file with atomic writes.
- Recognized the Comic API `PROCESSED` terminal status when waiting for generations.

## 0.1.0 - 2026-07-09

- Initial LlamaGen CLI release.
- Added Comic API CLI commands with promptUrl for uploaded Word, PDF, or TXT script files.
- Added Animation API CLI commands.
- Added local config management, CI, tests, and npm packaging metadata.
