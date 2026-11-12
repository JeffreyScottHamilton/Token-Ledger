---
name: account
description: Set up the private Token Ledger page in the user's Claude account, which adds up every device's total and shows it in Claude Code and on claude.ai. Use when the user wants their total combined across computers or cloud environments through their Claude account, or wants to link another device to their existing Token Ledger page.
disable-model-invocation: true
---

# Account page: one total across devices

The page is a private artifact in the user's Claude account. It holds one row per device in a database collection
named `devices`, and only the owner can read or write it. Each device's Token Ledger then:

- shows the combined total in `/token-ledger` (other devices' rows plus this computer's live total), and
- once a day, in the user's first chat, asks Claude to update this device's row. The user types nothing.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs"` (works the same in Bash and PowerShell). Token Ledger must
already be set up on this computer (`/token-ledger:setup`); if `token-ledger summary` says it is not, run setup first.

## 1. Find or create the page

1. List the user's artifacts (`Artifact` tool, `action: "list"`) and look for one titled **Token Ledger** whose
   description mentions the combined token total. If there is exactly one, use its URL. If there are several, ask
   which one.
2. If there is none, create it:
   - Copy `${CLAUDE_PLUGIN_ROOT}/account/token-ledger-page.html` into your scratchpad directory (or the current
     directory if there is no scratchpad). The Artifact tool only publishes files from those places.
   - Publish that copy with the `Artifact` tool: `icon: "chart"`,
     `description: "Combined Claude Code token total from every device that reports to it."`,
     and `capabilities: {"db": {"rules": [{"path": "devices", "read": "owner", "write": "owner"}]}}`.
     Do not change the page or the rules: the rules are what keep the rows private to the user.
   - The page is private to the user. Do not share it.

## 2. Link this device

Ask the user what to call this device on the page (suggest the computer's name, e.g. "Work laptop"). For a Claude Code
cloud environment use `--kind cloud`.

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" account link <page URL> --label "<name>"
```

Running it again with the same URL keeps the same device row; a new label just renames it.

## 3. First sync, now

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" account show --json
```

That prints `{ url, device, data }`. Then:

1. `ArtifactData` `get` with `url`, `collection: "devices"`, `doc_id: <device>` to learn the current `version`
   (a "not found" answer means this is the first write).
2. `ArtifactData` `set` with `url`, `collection: "devices"`, `doc_id: <device>`, `data: <data exactly as printed>`,
   and `if_version: <version>` when the row already existed.

Copy `data` exactly. Never add fields, and never put prompts, file paths or anything else in a row.

## 4. Tell the user

- The page link, and that it is private to them.
- `/token-ledger` now shows the combined total; `/token-ledger account` shows the link and the last sync.
- Each device updates its own row once a day during its first chat; `/token-ledger:sync` does it immediately.
- To add another computer: install Token Ledger there and run `/token-ledger:account` on it. It finds this same page.
- Do not also pair the same computers with `/token-ledger:pair`, or their usage would be counted twice.
- To stop on this device: `token-ledger account unlink`, then delete its row on the page if they want it gone.
