# Verification results

Claude Token Ledger 0.1.0, tested 2026-11-10 and 2026-11-11 with Claude Code 2.1.322 and Node.js 22.23.4 on Linux
(a Claude Code cloud container). "Live" means a real Claude Code client and real API requests. "Fixture" means
synthetic data through the real collector and CLI. "Simulated" means a stand-in for the real platform.

## Automated checks

| Check | Result |
| --- | --- |
| `npm test` (ledger, installer, release audit, mod format equivalence) | 43 / 43 pass |
| `claude plugin validate .` and `claude plugin validate plugin` | Pass |
| `claude plugin test plugin` (mod: counter states, details, `/usage`, pane, autostart, status row) | 16 / 16 pass |
| `bash scripts/smoke.sh` | Pass |
| `pwsh -NoProfile -File scripts/smoke.ps1` (PowerShell 7.4 on Linux) | Pass |
| GitHub Actions `ci.yml` / `release.yml` | Not run yet (no pull request or tag) |

## Acceptance checks (SPEC §9)

| # | Check | Result | Evidence | Kind |
| --- | --- | --- | --- | --- |
| A1 | Clean profile, install from the GitHub repo, real request reaches ledger, counter updates in the client | Pass | `claude plugin marketplace add JeffreyScottHamilton/Token-Ledger`, `claude plugin install token-ledger@token-ledger`, setup, `verify --live`: `1 new request, +36,954 tokens`. Interactive `/token-ledger` went 36,954 → 76,849 after one prompt. The paste-sentence flow, driven by Claude itself, also completed. | Live |
| A1 | Notice beside `/usage` | Pass | On closing the Usage panel: `token-ledger │ Total tracked tokens · 76,849` toast. The panel itself is unchanged. | Live |
| A2 | Setup twice, existing settings survive, no duplicates | Pass | `settings.json` SHA-256 identical after the second run; one backup; existing `statusLine` and `env.FOO` untouched. | Live + `05-installer.sh` |
| A2 | Uninstall | Pass | `--keep-data`: settings restored byte-exact, ledger kept. `--erase-data`: settings restored byte-exact, data folder removed, counter then reads `unavailable`. | `05-installer.sh` |
| A2 | Upgrade | Partial | `upgrade` re-runs the idempotent install and restarts the collector on a version change; no second release exists to upgrade between. | Unit tests |
| A3 | Two sources in one total | Pass | Primary over self-signed HTTPS + paired secondary on one machine; totals combine; per-source rows; revoked source gets 401 and its old records stay counted. | Fixture |
| A3 | Real cloud environment | Not verified | No public HTTPS collector was available. | — |
| A4 | Replay, restart, import twice, live + import overlap | Pass | Live OTel for 3 real requests (main + subagent), then import of the same transcripts: `already in ledger: 3, imported: 0`. Replays, `kill -9` and restart, second import and conflicting re-sends leave the total unchanged. | Live + `02-dedup.sh` |
| A5 | Delete transcript after capture; erase ledger | Pass | Total unchanged after deleting the transcripts; `erase --yes` gives a confirmed `0`. | Live + `02-dedup.sh` |
| A6 | Prompts, tool payloads, credentials never stored | Pass | Canaries in prompts (with `OTEL_LOG_USER_PROMPTS=1`), tool events, emails, account/org ids, raw request and session ids, file paths: no hits in db, WAL, log, summary, exports or backups. Tokens live only in a paired secondary's `config.json` (mode 0600). | Live + `04-privacy.sh` |
| A6 | Unauthorized ingest and reads | Pass | No token, wrong-scope token and revoked token → 401; >1 MiB → 413; protobuf → 415; bad `Host` or any `Origin` on loopback → 403; non-loopback bind without TLS refused. | Fixture (`03-remote.sh`, unit tests) |
| A7 | Windows PowerShell | Simulated | Smoke test under PowerShell 7.4 on Linux. Not run on Windows or on Windows PowerShell 5.1. | Simulated |
| A7 | Bash | Pass | Linux. | Live |

## Counting checks (`01-counting.sh`)

- Total = uncached input + output + cache writes + cache reads; the 5m/1h split is never added on top.
- String-encoded integers accepted; negative, fractional, NaN and oversize counts rejected.
- Events without a `request_id` are not counted and appear as a `partial_record` coverage gap.
- Bug found and fixed: a 5m/1h split larger than its cache-write total was kept, so details showed
  `Cache writes 514 (5m 601 / 1h 905)`. Such a split is now dropped and the total kept (`fixBreakdown`, with a test).

## Surfaces not verified

macOS, real Windows, Claude Desktop's Code tab, VS Code and JetBrains extensions, a real second computer, and a real
cloud environment. claude.ai's Usage settings and Claude Code's built-in Usage view have no documented extension point.
