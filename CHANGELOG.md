# Changelog

All notable changes to Claude Token Ledger are listed here. Versions follow [Semantic Versioning](https://semver.org/).

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
