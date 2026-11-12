# Privacy

Claude Token Ledger runs on your computer. By default nothing leaves it.

## What is stored

One record per API request, with exactly these fields (anything else is dropped before it is written):

| Field | Content |
| --- | --- |
| `rid` | a one-way hash of the request id (the raw id is not kept) |
| `ts`, `received_at` | request time, and when the ledger recorded it |
| `source` | the label you gave the computer or environment, e.g. `laptop` |
| `origin` | `otel`, `transcript`, `relay` or `demo` |
| `model` | model id |
| `session` | a one-way hash of the session id, or empty |
| `input`, `output`, `cache_write`, `cache_read`, `cache_write_5m`, `cache_write_1h` | token counts |

Also stored in the data folder (`~/.claude-token-ledger`, readable only by you):

- `config.json` — port, label, the Node.js path, pairing settings; if you had a logs exporter that setup now
  forwards to, its endpoint and headers (so it keeps working).
- `install-manifest.json` and `backups/` — what setup changed in `settings.json` and a copy of the file from before.
  The backup is your whole settings file, so treat it like the original.
- `collector.log` — one line per event with counts only.
- token hashes for paired computers (the tokens themselves are shown once and not kept).

## What is never stored

Prompts, replies, tool names, tool inputs or outputs, file paths, working directories, email addresses, account or
organization ids, raw session ids, raw request ids, HTTP headers, credentials, and raw telemetry bodies. Telemetry
events other than `api_request` are ignored. Transcripts are read for usage numbers only and are never copied.

## Network

- The collector listens on `127.0.0.1:47318` only. It refuses a non-loopback address without TLS.
- No analytics, no update checks, no third-party services.
- Data leaves the computer only if you ask for it:
  - **pairing** — a paired computer sends its records (the fields above) to your primary over HTTPS;
  - **forwarding** — if you already exported logs to your own endpoint, the collector passes each telemetry body on
    to it unchanged, exactly as Claude Code did before.
- `verify --live` sends one short prompt through Claude Code itself, like any other request you make.

## Tokens

Pairing uses random 256-bit tokens. *Ingest* tokens can only add records for one source; *read* tokens can only read
the summary. Only their hashes are stored. `source revoke <label>` takes effect immediately. A pairing code contains
an ingest token: treat it as a password.

## Your controls

- Export: `token-ledger export --format json|csv --out FILE`
- Erase all records: `token-ledger erase --yes`
- Remove everything: `token-ledger uninstall --erase-data`
