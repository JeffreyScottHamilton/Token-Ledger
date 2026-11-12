# Changelog

All notable changes to Claude Token Ledger are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Account page: a private Token Ledger page in your Claude account adds up every device's total
  (`/token-ledger:account`, `/token-ledger:sync`, `/token-ledger account`, `token-ledger account link|unlink|show`).
  `/token-ledger` shows the combined total; each device syncs once a day in its first chat.

### Fixed
- A 5-minute/1-hour cache-write split larger than its cache-write total is dropped instead of shown.
- CI: the PowerShell smoke jobs no longer use an expression as a step's shell, which GitHub rejected.

## [0.1.0] - 2026-11-10

First release.

### Added
- Local ledger of Claude Code API token usage (SQLite, Node.js built-in; no dependencies).
- Collector on `127.0.0.1:47318` for Claude Code OpenTelemetry logs, plus transcript import and incremental sync;
  each API request is counted once, whichever way it arrives.
- In Claude Code: `/token-ledger`, `/token-ledger details`, `/token-ledger pane`, a notice beside `/usage`, and an
  optional status row.
- Guided setup (`/token-ledger:setup`), pairing of other computers and cloud environments over HTTPS
  (`/token-ledger:pair`), export/erase (`/token-ledger:export`) and uninstall (`/token-ledger:uninstall`).
- Idempotent installer: backs up `settings.json`, adds only the logs-telemetry keys, keeps existing telemetry,
  status line and plugins, and removes exactly what it added on uninstall.
- Optional composable status-line segment (`token-ledger statusline wrap|unwrap`).
- Windows (PowerShell 5.1+/7), macOS and Linux support.
