---
name: export
description: Export the Token Ledger records to a JSON or CSV file, or erase the ledger. Use when the user asks to export, download, back up, delete or reset their tracked token data.
disable-model-invocation: true
---

# Export or erase the ledger

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs"` (Bash and PowerShell).

## Export

Ask where to save the file, then:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" export --format json --out <file>
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" export --format csv --out <file>
```

The export holds one row per API request: time, source label, model, token counts, and hashed identifiers.
It holds no prompts, replies, file paths or account details — the ledger never stores them.

## Erase

Erasing deletes every record and resets the total to 0. It cannot be undone. **Confirm with the user first**
and offer an export. Then:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" erase --yes
```

Configuration and pairing stay in place, and counting continues from zero. Old Claude Code transcripts still on
disk can be re-imported later with `import --yes`. To remove Token Ledger entirely use `/token-ledger:uninstall`.
