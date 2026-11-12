# Handoff: Claude Token Ledger

Paste the prompt below into the next assistant (ChatGPT or another Claude session). It is self-contained.

---

## Prompt

You are continuing development of **Claude Token Ledger**, a Claude Code plugin that shows one running total of
Claude Code tokens (`Total tracked tokens · 12,483,910`) across a person's computers and cloud environments.

**Repository:** https://github.com/JeffreyScottHamilton/Token-Ledger
**Working branch:** `claude/keen-heisenberg-0e9mt6` (all work so far is pushed there; `main` does not exist yet).
**Read first:** `docs/SPEC.md` (binding contract: record schema, summary interface, collector API, CLI, install rules,
acceptance tests), then `README.md`, `docs/COVERAGE.md`, `docs/PRIVACY.md`, `docs/INSTALL.md`.

### What exists and works

- **Ledger** (`plugin/lib/*.mjs`, `plugin/bin/token-ledger.mjs`): Node.js ≥ 22.13, zero npm dependencies, built-in
  `node:sqlite`. Loopback OTLP/HTTP-JSON collector on `127.0.0.1:47318`, transcript import/sync, dedup by hashed
  Anthropic `request_id`, HTTPS remote mode with separate revocable ingest/read tokens, pairing (`pair create/join`),
  relay with durable outbox, export, erase, synthetic demo data (`demo/`).
- **Mod** (`plugin/hooks/register.tsx`, `format.ts`): `/token-ledger` (one line), `/token-ledger details`,
  `/token-ledger refresh`, `/token-ledger pane`; a notice with the total when the built-in `/usage` panel closes;
  opt-in status row (`userConfig.showStatusRow`, default off). Starts the collector at session start.
- **Installer** (`plugin/lib/install/*.mjs`, `plugin/skills/{setup,pair,uninstall,export}`): idempotent setup that adds
  five logs-only OTel env keys to `~/.claude/settings.json` with a backup and a manifest; uninstall removes only those
  keys; coexists with existing telemetry and status lines; `verify --live` sends one real request.
- **Release**: `.github/workflows/ci.yml` and `release.yml` (never run on GitHub yet), `scripts/build-release.mjs`,
  `scripts/audit-release.mjs`, `scripts/smoke.sh`, `scripts/smoke.ps1`. MIT license.

### Key decisions (do not undo without reason)

- Plugin and marketplace slug is **`token-ledger`**, not `claude-token-ledger`: `claude plugin validate` (2.1.322)
  rejects third-party names starting with `claude-`. Install id: `token-ledger@token-ledger`.
- Claude Code's built-in Usage view has **no extension point** (verified in the Mods API types for 2.1.321/2.1.322).
  Registering a command named `usage` is refused; appending text to `/usage` is dropped interactively. Hence the
  `/token-ledger` command plus a notice on closing `/usage`.
- `total = uncached input + output + cache writes + cache reads`; the 5m/1h cache-write split is a breakdown only.
- Records without a `request_id` are not counted; they are tallied as `partial_record` coverage gaps.
- `sync` only catches up usage from setup time onward; older history is opt-in through `import --dry-run` then
  `import --yes`.
- Minimum versions: Claude Code 2.1.300, Node.js 22.13.

### Verified so far (Linux cloud container, Claude Code 2.1.322, Node 22.23)

- `npm test`: 42/42 pass. `claude plugin validate .` and `claude plugin validate plugin` pass.
  `claude plugin test plugin`: 16/16 pass.
- `bash scripts/smoke.sh` and `pwsh -NoProfile -File scripts/smoke.ps1` (PowerShell 7.4 on Linux) pass.
- Clean profile: `claude plugin marketplace add JeffreyScottHamilton/Token-Ledger` + `claude plugin install
  token-ledger@token-ledger` from GitHub, setup twice (settings byte-identical), `verify --live` saw a real request,
  interactive `/token-ledger` rose 36,954 → 76,849 after one prompt, notice shown on closing `/usage`, existing status
  line untouched, `uninstall --keep-data` restored settings and kept data.
- Live OTel + transcript import of the same session (main + subagent, 3 requests) dedups to 3; total unchanged after
  collector restart and after deleting the transcript; `erase --yes` returns a confirmed 0.
- Prompt canary sent with `OTEL_LOG_USER_PROMPTS=1` never reached the ledger files.

### Not done yet — your tasks, in order

1. **Run the acceptance scripts** in `tests/acceptance/` (`01-counting.sh` … `05-installer.sh`, helper `common.sh`).
   They were written by an independent verification pass that was cut off by a rate limit; `04` and `05` are
   uncommitted-quality and may need finishing. Use temp `CLAUDE_CONFIG_DIR`, `TOKEN_LEDGER_HOME`, and ports 47400–47450.
   Fix any product bug they reveal, keeping `npm test` green. Write results to `docs/VERIFICATION.md` as a table
   (check, result, evidence, live / fixture / simulated). README links to that file and it does not exist yet.
2. **Docs accuracy pass**: every command and flag in `README.md`, `docs/INSTALL.md` and `plugin/skills/*/SKILL.md`
   must exist in `node plugin/bin/token-ledger.mjs --help`. The pairing `serve --host … --tls-cert …` steps and the
   cloud-environment steps were written from help text and are unverified.
3. **Publish**: open a pull request from `claude/keen-heisenberg-0e9mt6` into a new default branch (or ask the owner
   which branch should be default), let CI run on Ubuntu, macOS and Windows, fix failures, then tag `v0.1.0`
   (plugin.json, marketplace.json and package.json are all `0.1.0`) so `release.yml` builds the archives.
   The README pins `#v0.1.0`; until the tag exists, install without the pin.
4. **Install for real use** on the owner's own computer by pasting into Claude Code:
   > Can you install Claude Token Ledger for me from this GitHub repo? Set it up on this computer, check that it's
   > working, and show me where to see my total. https://github.com/JeffreyScottHamilton/Token-Ledger
   Then run `/token-ledger` and `/token-ledger details`.
5. Still unverified, list honestly: real Windows (and Windows PowerShell 5.1), macOS, Claude Desktop Code tab,
   VS Code/JetBrains, a real second computer, a real cloud environment with a public HTTPS collector.

### Rules

- Never store or log prompts, replies, tool payloads, file paths, emails, account/org ids, raw session or request ids,
  or credentials. Allowlist fields before writing (see `plugin/lib/normalize.mjs`).
- Never show `0` unless the ledger is readable and empty; otherwise show `unavailable` or a stale total.
- Never change a user's existing `statusLine`, plugins or other telemetry without the reversible, recorded path.
- Do not test against a real `~/.claude`; use temp config dirs.
