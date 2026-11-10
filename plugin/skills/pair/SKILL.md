---
name: pair
description: Connect another computer or a cloud environment to this Token Ledger so all usage adds up to one total. Use when the user wants to add, pair, connect or revoke a second computer or source.
disable-model-invocation: true
---

# Pair another computer

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs"` (Bash and PowerShell). One computer is the **primary**
(holds the ledger); the others relay their usage to it.

## What the primary needs first

The other computer must reach the primary over **HTTPS**. Ask the user which they have:

- both computers on the same VPN / Tailscale network (simplest), or
- a public host name that points to the primary.

The primary needs a TLS certificate and key for that name (for Tailscale: `tailscale cert <name>`), then runs its
collector on that address:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" stop
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" serve --host <address> --port 47319 --tls-cert <cert.pem> --tls-key <key.pem>
```

Plain HTTP on a non-loopback address is refused by design. Do not suggest exposing port 47318.

## On the primary: create a pairing code

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" pair create <label> --url https://<name>:47319
```

`<label>` names the other computer (lowercase letters, digits, dashes — e.g. `work-laptop`). Add `--kind cloud`
for a cloud environment, and `--ca <file>` if the certificate is self-signed. The printed code is a **secret** and
works once: tell the user to copy it straight to the other computer and not to paste it into chats or tickets.
Never repeat the code back in your own messages.

## On the other computer: join

Token Ledger must be installed there too (`/token-ledger:setup`). Then:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" pair join <code>
```

From then on its collector forwards every recorded request to the primary and keeps unsent ones until they are
acknowledged. Check on the primary with `/token-ledger details` — the new source shows as `reporting`.

## Cloud environments (Claude Code on the web)

Set the telemetry variables in the environment's settings, pointing at the primary's HTTPS address, and put the
ingest token in the environment's **network secret** (the proxy adds the header; the token never enters the
sandbox). See `docs/INSTALL.md`, "Cloud environments".

## Revoke

```
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" source list
node "${CLAUDE_PLUGIN_ROOT}/bin/token-ledger.mjs" source revoke <label>
```

Revocation is immediate. Tokens already counted from that source stay in the total.
