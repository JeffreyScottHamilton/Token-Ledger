---
name: setup
description: Set up Claude Token Ledger on this computer - check requirements, connect Claude Code telemetry to the local ledger, verify with one real request, and show where the total appears. Use when the user asks to install, set up, repair or verify Token Ledger.
---

# Set up Claude Token Ledger

Follow these steps in order. Every step is safe to repeat; a second run changes nothing that is already correct.
Never edit `settings.json` by hand — the installer does it (with a backup) and records what it added.

The ledger CLI is: `node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs"` (same command in Bash and PowerShell).
If that path was not filled in above (you see a literal `${...}`), find the plugin folder with
`claude plugin list --json` (field `installPath` of `token-ledger@token-ledger`) and use `<installPath>/bin/token-ledger.mjs`.

## 1. Check the computer

Detect the OS and shell first (PowerShell on Windows, Bash elsewhere), then run:

```
claude --version
node --version
```

- Claude Code must be **2.1.300 or newer**. If older, tell the user to update (`claude update`) and stop.
- Node.js must be **22.13 or newer**. If missing or older, ask the user before installing, then use:
  - Windows (PowerShell): `winget install OpenJS.NodeJS.LTS` — then open a new terminal
  - macOS: `brew install node`
  - Linux: `nvm install --lts`, or the distribution's Node 22+ package

## 2. Install

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" install --yes --no-import
```

Read the output to the user in plain words: what was added to `settings.json`, whether an existing telemetry
setup or status line was found (both are left intact), and whether live data comes from OpenTelemetry or from
transcript sync (the latter happens when an organization manages telemetry or another exporter is in use).
If it exits non-zero, show the message, run `... token-ledger.mjs doctor`, and stop.

## 3. Offer the history import

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" import --dry-run
```

Tell the user the date range and how many past requests can be added. **Ask before importing.** Only if they agree:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" import --yes
```

## 4. Verify with a real request

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" verify --live
```

Success prints `Verified: a real Claude Code request reached the ledger (+N tokens).`
If it fails, report the exact line it printed and run `doctor`. Do not claim success without the `Verified:` line.

## 5. Tell the user what to do next

Say exactly this, adapted to what happened:

1. **Restart Claude Code (exit and reopen)** so this session also reports live. New sessions already do. After a plugin update, `/reload-plugins` reloads the plugin.
2. Run **`/token-ledger`** to see the one-line total: `Total tracked tokens · 12,483,910`.
3. Run **`/token-ledger details`** for the breakdown, sources and coverage gaps; `/token-ledger pane` keeps it open.
4. The counter also appears as a notice when you run **`/usage`**. Claude's own Usage screen cannot be extended by plugins, so the total is shown beside it, not inside it.
5. The total counts recorded Claude Code API tokens. It is not a bill and not a plan-limit meter. Regular claude.ai chats are not included.

To add another computer use `/token-ledger:pair`; to remove everything use `/token-ledger:uninstall`.
