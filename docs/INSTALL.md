# Install Claude Token Ledger (v0.1.0)

These are the exact steps. Claude Code can follow them for you: paste the sentence from the
[README](../README.md#set-up-with-claude-code) into Claude Code. Every step is safe to repeat.

Names: the public name is **Claude Token Ledger**; the plugin and marketplace are both called `token-ledger`
(Claude Code reserves plugin names starting with `claude-`), so the install id is `token-ledger@token-ledger`.

## Requirements

| Needed | Version | Check |
| --- | --- | --- |
| Claude Code | 2.1.300 or newer | `claude --version` |
| Node.js | 22.13 or newer | `node --version` |
| Shell | Windows PowerShell 5.1+ or PowerShell 7; bash/zsh on macOS and Linux | |

Missing Node.js? Windows: `winget install OpenJS.NodeJS.LTS` (then open a new terminal). macOS: `brew install node`.
Linux: `nvm install --lts` or your distribution's Node 22+ package.

## Steps

The commands are the same in PowerShell and Bash unless marked.

1. **Check versions**

   ```
   claude --version
   node --version
   ```

2. **Add the marketplace, pinned to this release, and install the plugin**

   ```
   claude plugin marketplace add JeffreyScottHamilton/Token-Ledger#v0.1.0
   claude plugin install token-ledger@token-ledger
   ```

   Inside a Claude Code session the same thing is `/plugin marketplace add JeffreyScottHamilton/Token-Ledger#v0.1.0`
   then `/plugin install token-ledger@token-ledger`. Leave out `#v0.1.0` to follow the default branch instead, or if that tag is not published yet.

3. **Find the plugin folder**

   ```
   claude plugin list --json
   ```

   In the `token-ledger@token-ledger` entry use `readFromFolder` if it is present, otherwise `installPath`.
   Below, `<plugin>` means that folder.

4. **Run setup**

   ```
   node "<plugin>/bin/token-ledger.mjs" install --yes --no-import
   ```

   What this does:
   - creates the data folder `~/.claude-token-ledger` (Windows: `%USERPROFILE%\.claude-token-ledger`);
   - backs up `~/.claude/settings.json` into `backups/` there, then adds five `env` keys so Claude Code sends
     usage events (logs only) to the local collector: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOGS_EXPORTER`,
     `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_LOGS_EXPORT_INTERVAL`;
   - records exactly what it added in `install-manifest.json`, so uninstall can remove only that;
   - starts the collector on `127.0.0.1:47318`.

   What it never does: change your status line, your plugins, your metrics/traces telemetry, or anything in managed
   (organization) settings. See [Existing telemetry](#existing-telemetry).

5. **History (optional — ask first)**

   ```
   node "<plugin>/bin/token-ledger.mjs" import --dry-run
   node "<plugin>/bin/token-ledger.mjs" import --yes
   ```

   The dry run prints the date range and how many past requests are eligible. Nothing is written until `--yes`.

6. **Verify with one real request**

   ```
   node "<plugin>/bin/token-ledger.mjs" verify --live
   ```

   Expected last line: `Verified: a real Claude Code request reached the ledger (N new requests, +N tokens since the check began).`
   This sends one tiny prompt with `claude -p`, so Claude Code must be signed in.

7. **Restart Claude Code** (exit and reopen) so already-open sessions pick up the telemetry settings.
   After plugin updates, `/reload-plugins` reloads the plugin.

8. **See the total**

   - `/token-ledger` — one line: `Total tracked tokens · 12,483,910`
   - `/token-ledger details` — breakdown, sources, coverage gaps
   - `/token-ledger pane` — keeps the details open
   - `/usage` — Claude's own usage screen; the counter appears beside it as a notice
   - optional status row: `/plugin configure token-ledger@token-ledger` → *Show status row*

If the plugin is already installed, steps 4–8 are the `/token-ledger:setup` skill.

## Existing telemetry

| What setup finds | What it does |
| --- | --- |
| No telemetry settings | Adds the five keys above. |
| Metrics or traces exporters | Leaves them untouched. |
| A logs exporter using `http/json` to another endpoint | Keeps it working: Claude Code sends to the local collector, which forwards every body unchanged to your endpoint. Your previous values are saved and restored on uninstall. |
| A logs exporter using `grpc` or `http/protobuf`, a non-OTLP exporter, or `otelHeadersHelper` | Changes nothing. Live OTel left to your existing collector; Token Ledger uses transcript sync. |
| Organization-managed settings that set `OTEL_EXPORTER_OTLP_*` | Changes nothing. Reports an *authority* gap and uses transcript sync. |
| `CLAUDE_CODE_ENABLE_TELEMETRY=0` | Respects it; uses transcript sync. |

Telemetry variables in a project's `.claude/settings.json` are ignored by Claude Code, so setup only ever edits the
user file.

## Another computer

Run `/token-ledger:pair`, or by hand:

```
# on the primary (must be reachable over HTTPS: VPN/Tailscale or a public name, with a TLS certificate)
node "<plugin>/bin/token-ledger.mjs" serve --host <address> --port 47319 --tls-cert cert.pem --tls-key key.pem
node "<plugin>/bin/token-ledger.mjs" pair create work-laptop --url https://<name>:47319

# on the other computer (after steps 1–4 there)
node "<plugin>/bin/token-ledger.mjs" pair join <code>
```

The code is a one-time secret. Revoke a computer with `source revoke <label>`.

## Cloud environments

Claude Code on the web runs on Anthropic's machines, so it cannot reach `127.0.0.1` on yours. To count it:

1. Make the primary reachable over HTTPS (as for pairing) and create a cloud source:
   `pair create cloud-web --kind cloud --url https://<name>:47319`.
2. In the cloud environment's settings add the environment variables `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
   `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`,
   `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://<name>:47319/v1/logs`. Do not put the token in a variable.
3. Add the ingest token as a **network secret** for that host (header `Authorization`, prefix `Bearer`), so the
   environment's proxy attaches it and the token never enters the sandbox. Add the host to the allowed hosts.

Status: unverified end to end — see [COVERAGE.md](COVERAGE.md).

## Upgrade

```
claude plugin marketplace update token-ledger
claude plugin update token-ledger@token-ledger
node "<plugin>/bin/token-ledger.mjs" upgrade
```

`upgrade` re-runs the idempotent setup steps and restarts the collector if the version changed. A marketplace added
with `#v0.1.0` stays on that tag; to move to a newer tag, remove the marketplace and add it again with the new tag.
Your ledger data is kept.

## Uninstall

```
node "<plugin>/bin/token-ledger.mjs" uninstall --keep-data     # or --erase-data
claude plugin uninstall token-ledger@token-ledger
claude plugin marketplace remove token-ledger
```

The first command stops the collector and restores `settings.json` (only the keys setup added; if you changed one
afterwards it is left alone and listed). `--erase-data` deletes `~/.claude-token-ledger`.

## Troubleshooting

`node "<plugin>/bin/token-ledger.mjs" doctor` prints versions, paths, which settings keys are in place, collector
health and coverage gaps. It prints no secrets.

| Symptom | Fix |
| --- | --- |
| `verify --live` finds no new request | Restart Claude Code and try again; check `doctor` for managed settings. |
| `Total tracked tokens · unavailable` | The ledger cannot be read. Run `doctor`; start the collector with `token-ledger start`. |
| Port 47318 in use | Set `"port"` in `~/.claude-token-ledger/config.json` and run `install --yes` again. |
