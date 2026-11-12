# Claude Token Ledger

One running total of the tokens you use in Claude Code — across your computers and cloud environments — shown
inside Claude Code:

```
Total tracked tokens · 12,483,910
```

## Set up with Claude Code

Open Claude Code and paste this:

> Can you install Claude Token Ledger for me from this GitHub repo? Set it up on this computer, check that it’s working, and show me where to see my total. https://github.com/JeffreyScottHamilton/Token-Ledger

**What Claude will do**

1. Check that Claude Code (2.1.300 or newer) and Node.js (22.13 or newer) are installed, and offer to install Node.js if it is missing.
2. Add this repository as a plugin marketplace and install the `token-ledger` plugin.
3. Run setup: back up your `settings.json`, add five telemetry settings that point Claude Code at a small collector on your own computer, and start that collector.
4. Show you how much past usage it can import, and ask before importing it.
5. Send one tiny real request and confirm it reached the ledger.
6. Tell you to restart Claude Code and where to see the total.

Claude follows [docs/INSTALL.md](docs/INSTALL.md). Setup is safe to run twice, and asks before installing anything.

## What you see

| Where | What |
| --- | --- |
| `/token-ledger` | One line: `Total tracked tokens · 12,483,910` |
| `/token-ledger details` | Breakdown by token type, each computer or environment, and known coverage gaps |
| `/token-ledger pane` | The details, kept open beside the chat |
| `/usage` | Claude's own usage screen, with the counter shown beside it as a notice |
| Status row (optional, off by default) | The counter under the prompt. Turn on with `/plugin configure token-ledger@token-ledger` |

Claude Code has no supported way for a plugin to add a row *inside* its built-in Usage screen or the claude.ai
Usage settings page, so the counter appears next to them instead.

If the ledger cannot be read, the line says `Total tracked tokens · unavailable`. It never shows `0` for "unknown".

## Requirements

- Claude Code **2.1.300 or newer** (`claude --version`)
- Node.js **22.13 or newer** (`node --version`) — no other dependencies
- Windows (PowerShell 5.1+ or PowerShell 7), macOS or Linux (bash/zsh)

## Install by hand

```
claude plugin marketplace add JeffreyScottHamilton/Token-Ledger#v0.1.0
claude plugin install token-ledger@token-ledger
```

Then open Claude Code and run `/token-ledger:setup`. (Inside a session the first two are
`/plugin marketplace add JeffreyScottHamilton/Token-Ledger#v0.1.0` and `/plugin install token-ledger@token-ledger`.)
`#v0.1.0` pins the release; leave it out to follow the default branch (also do that if the tag is not published yet). Full steps: [docs/INSTALL.md](docs/INSTALL.md).

**About the names.** The project is *Claude Token Ledger* and the GitHub repository is
`JeffreyScottHamilton/Token-Ledger`. The plugin and its marketplace are both named `token-ledger` — not
`claude-token-ledger` — because Claude Code reserves plugin names that start with `claude-` for Anthropic's own
plugins. This is an independent project, not an Anthropic product.

## How counting works

- Each request Claude Code makes to the model is recorded once, with four numbers:
  **uncached input + output + cache writes + cache reads**. Their sum is the total.
- Cache writes are also shown split into 5-minute and 1-hour writes. That is a breakdown only; it is not added again.
- Subagents and retries are counted per actual request — nothing is estimated.
- Usage arrives two ways: live, from Claude Code's built-in OpenTelemetry events, and from Claude Code's own
  session transcripts. Both carry the same request id, so a request seen twice still counts once.
- The total starts when you set up (plus any history you choose to import) and keeps counting after transcripts
  are deleted.

**This is not your bill and not your plan limit.** Plans and prices weigh models and cached tokens differently.
Regular claude.ai chats (web, desktop and mobile chat) are not included: they expose no usage data to count.
See [docs/COVERAGE.md](docs/COVERAGE.md) for exactly what is and is not covered.

## One total across all your devices (your Claude account)

Run `/token-ledger:account` once on each computer. The first run creates a private **Token Ledger** page in your
Claude account; later runs find it and link that device too.

- `/token-ledger` then shows the combined total: every other device's latest figure plus this computer's live one.
- The page shows the same total on claude.ai, on the web and on your phone. Only you can open it.
- Each device updates its own line once a day, in your first Claude Code chat. You type nothing; Claude makes one
  quick write to the page before answering. `/token-ledger:sync` does it immediately.
- `/token-ledger account` shows the page link and when this device last synced.

Why Claude makes the write and not the plugin: Claude Code requires a person's approval for writes to your account's
data, and a plugin cannot ask for that on its own. So a device's line refreshes when you use Claude Code there; a
device you haven't used in a while shows its last figure. Each daily sync uses a small amount of your usage.

Use either the account page or pairing (below) for a given computer, not both, or its usage is counted twice.

## Connect another computer

Install on the second computer too, then run `/token-ledger:pair` on both. The first computer (the *primary*) must
be reachable from the second over HTTPS — for example on the same VPN or Tailscale network. You create a one-time
code on the primary and enter it on the other; from then on its usage is added to the same total. Remove a computer
any time with `token-ledger source revoke <label>`. Details: [docs/INSTALL.md](docs/INSTALL.md#another-computer).

## Cloud environments

Claude Code on the web runs on Anthropic's machines and cannot reach a collector on your computer. It can be counted
if your primary is reachable over HTTPS: you set the telemetry variables in the cloud environment and store the
ledger's ingest token as a network secret there. Steps: [docs/INSTALL.md](docs/INSTALL.md#cloud-environments).

## Coverage

[docs/COVERAGE.md](docs/COVERAGE.md) lists every source — terminal, Desktop, IDE extensions, cloud, other providers —
with its status and how it was verified.

## Privacy

- Everything stays on your computer in `~/.claude-token-ledger`. The collector listens on `127.0.0.1` only.
- Stored per request: time, a label for the computer, the model name, the token counts, and one-way hashes of the
  request and session ids.
- Never stored: prompts, replies, tool calls, file names or paths, your email or account ids, credentials.
- No analytics and no third-party services. Data leaves your computer only to a computer you pair yourself.

More: [docs/PRIVACY.md](docs/PRIVACY.md).

## Export or delete your data

Run `/token-ledger:export`, or in a terminal:

```
token-ledger export --format csv --out my-usage.csv
token-ledger erase --yes
```

`erase` deletes all records and resets the total to 0. (`token-ledger` is on the path inside Claude Code; elsewhere
run `node <plugin folder>/bin/token-ledger.mjs`.)

## Upgrade

```
claude plugin marketplace update token-ledger
claude plugin update token-ledger@token-ledger
```

Restart Claude Code, then run `/token-ledger:setup` once more (it only changes what needs changing). Your data is kept.

## Uninstall

Run `/token-ledger:uninstall`. It asks whether to keep or erase your ledger, restores `settings.json` to how it was
(only the keys setup added are removed), and gives you the final command:

```
claude plugin uninstall token-ledger@token-ledger
```

## Surfaces verified

<!-- VERIFIED-SURFACES -->
Tested on 2026-11-10 with Claude Code 2.1.322 and Node.js 22.23 on Linux (a Claude Code cloud container).

| Surface | Status | What was checked |
| --- | --- | --- |
| Claude Code terminal (Linux, bash) | **Verified live** | Install from this GitHub repo into a clean profile, setup twice, a real request reached the ledger, `/token-ledger` rose from 36,954 to 76,849 after one real prompt, the notice appeared on closing `/usage`, an existing status line stayed, uninstall restored settings. |
| Claude Code headless (`claude -p`) | **Verified live** | `/token-ledger` and `/token-ledger details` print the total; `/usage` gains one extra line. |
| Windows PowerShell | **Simulated** | Setup, replay and uninstall smoke test passed under PowerShell 7.4 on Linux. Not run on Windows itself, and not on Windows PowerShell 5.1. |
| macOS | **Not verified** | Covered by the CI matrix once the workflows run on GitHub. |
| Claude Desktop Code tab, VS Code, JetBrains | **Not verified** | The pane and commands pass the plugin test kit for these surfaces; no real client was run. |
| Second computer / cloud environment | **Fixture only** | Pairing and relay tested over self-signed HTTPS on one machine. No real second machine or public collector was used. |
| claude.ai website Usage settings | **Not supported** | Anthropic documents no extension point. Claude Code's own Usage screen has none either, so the counter sits beside it. |

Details: [docs/VERIFICATION.md](docs/VERIFICATION.md).
<!-- /VERIFIED-SURFACES -->

## Development

```
npm test                         # all tests (Node.js 22.13+)
bash scripts/smoke.sh            # end-to-end smoke test in temporary folders
pwsh scripts/smoke.ps1           # the same under PowerShell
node scripts/build-release.mjs   # build and audit release archives into dist/
```

## License

[MIT](LICENSE) © 2026 Claude Token Ledger contributors
