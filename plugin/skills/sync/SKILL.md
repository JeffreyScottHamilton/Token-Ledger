---
name: sync
description: Update this device's row on the user's private Token Ledger account page right now, instead of waiting for the daily sync. Use when the user asks to sync, push or refresh their Token Ledger account total.
disable-model-invocation: true
---

# Sync this device to the account page now

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" account show --json` (Bash or PowerShell).
   If it says no account page is linked, tell the user to run `/token-ledger:account` and stop.
2. `ArtifactData` `get` with the printed `url`, `collection: "devices"`, `doc_id: <device>` to read the row's
   current `version` ("not found" means it is the first write).
3. `ArtifactData` `set` with `url`, `collection: "devices"`, `doc_id: <device>`, `data: <data exactly as printed>`,
   plus `if_version: <version>` when the row exists. Copy `data` exactly; add nothing.
4. Reply with one line: the device name and its total, e.g. `Synced Work laptop: 1,234,567 tokens.`
   Then suggest `/token-ledger` for the combined total.
