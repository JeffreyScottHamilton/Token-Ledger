---
name: uninstall
description: Remove Claude Token Ledger from this computer - restore settings, stop the collector, and keep or erase the ledger data. Use only when the user asks to uninstall or remove Token Ledger.
disable-model-invocation: true
---

# Uninstall Claude Token Ledger

1. **Ask the user** which they want — do not choose for them:
   - **Keep data**: the ledger stays in `~/.claude-token-ledger` and a later reinstall continues the same total.
   - **Erase data**: the ledger, its configuration and pairing tokens are deleted. This cannot be undone.
     Offer an export first (`/token-ledger:export`).

2. Run one of (same in Bash and PowerShell):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" uninstall --keep-data
   node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" uninstall --erase-data
   ```

   This stops the collector, removes only the `settings.json` keys Token Ledger added (restoring any value it
   replaced; keys the user changed afterwards are left alone and listed), and unwraps the status line if it was wrapped.

3. Remove the plugin itself. This must run outside the plugin, so give the user the command:
   - in a terminal: `claude plugin uninstall token-ledger@token-ledger`
   - or in a session: `/plugin uninstall token-ledger@token-ledger`
   - optionally also: `claude plugin marketplace remove token-ledger`

4. Tell the user to restart Claude Code so the telemetry settings stop applying to running sessions.
