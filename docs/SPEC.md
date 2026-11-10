# Claude Token Ledger — Build Specification (v0.1)

Owner: project manager. This file is the contract between components. Changes go through the manager.

Names:
- Public name: **Claude Token Ledger**
- Repository / plugin slug / marketplace name: `claude-token-ledger`
- In-app label: **Token Ledger**
- Counter line: `Total tracked tokens · 12,483,910`

## 1. Architecture

```
Claude Code ──OTLP http/json logs──▶ collector (127.0.0.1:47318) ──▶ SQLite ledger ──▶ summary.json
   │                                    ▲        ▲                                     │
   │ transcripts (~/.claude/projects)   │        │ relay (HTTPS, ingest token)          ▼
   └──── token-ledger sync/import ──────┘   other computers / cloud envs     mod (/token-ledger, /usage row)
```

- Runtime: Node.js **>= 22.13** (built-in `node:sqlite`, no npm dependencies). Zero runtime deps.
- Data home: `~/.claude-token-ledger/` (override `TOKEN_LEDGER_HOME`). Survives plugin uninstall unless the user erases it.
  - `ledger.db` SQLite (WAL), `summary.json` (atomic write), `config.json` (0600), `install-manifest.json`,
    `collector.pid`, `collector.log` (no payloads), `backups/`.
- One CLI: `plugin/bin/token-ledger.mjs` (`node <path> <command>`); wrappers `token-ledger` (sh) and `token-ledger.cmd`/`.ps1`.

## 2. Repository layout and file ownership

| Path | Owner |
| --- | --- |
| `plugin/lib/**`, `plugin/bin/token-ledger.mjs`, `tests/ledger/**`, `demo/**` | Ledger engineer |
| `plugin/hooks/**`, `plugin/types/**`, `tests/mod/**` | Mod engineer |
| `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/skills/**`, `plugin/lib/install/**`, `plugin/bin/token-ledger` `*.cmd` `*.ps1`, `scripts/**`, `.github/**`, `tests/install/**`, `README.md`, `LICENSE`, `CHANGELOG.md`, `docs/INSTALL.md`, `docs/COVERAGE.md`, `docs/PRIVACY.md` | Installer & release engineer |
| `tests/acceptance/**`, `docs/VERIFICATION.md` | Verification agent |
| `docs/SPEC.md` | Manager |

Installer code adds CLI commands by exporting handlers from `plugin/lib/install/index.mjs`; the ledger CLI dispatches
`install|uninstall|upgrade|pair|doctor|verify|statusline` to it (lazy import). Nothing else crosses boundaries.

## 3. Normalized usage record (the only thing written to disk)

Allowlist. Any field not listed is dropped before storage.

| Field | Type | Meaning |
| --- | --- | --- |
| `rid` | TEXT PK | `sha256("anthropic-request:" + request_id)` hex, first 32 chars. Fallback key: `sha256("anthropic-message:" + message_id)`. Records with neither are rejected as `partial_record` gaps. |
| `ts` | INTEGER | request time, ms since epoch (UTC) |
| `source` | TEXT | source label (`laptop`, `cloud-web`, …), `[a-z0-9-]{1,40}` |
| `origin` | TEXT | `otel` \| `transcript` \| `relay` \| `demo` |
| `model` | TEXT | model id, `[A-Za-z0-9._:\-\[\]]{1,80}` else `unknown` |
| `session` | TEXT | `sha256("session:" + session_id)` first 16 hex chars, or NULL |
| `input` | INTEGER ≥0 | uncached input tokens |
| `output` | INTEGER ≥0 | output tokens |
| `cache_write` | INTEGER ≥0 | cache creation tokens (total) |
| `cache_read` | INTEGER ≥0 | cache read tokens |
| `cache_write_5m`, `cache_write_1h` | INTEGER NULL | breakdown of `cache_write` only; never added to the total |
| `received_at` | INTEGER | ms epoch the ledger committed it |

`total = input + output + cache_write + cache_read`. Counts must be finite integers 0 ≤ n ≤ 10^9 each.

Dedup: `INSERT … ON CONFLICT(rid) DO NOTHING`. When a conflicting record from a different origin carries different
counts, keep the first, increment `diagnostics.conflicts`. Live OTel and transcript records of the same API call share
`request_id` (see §6), so overlap collapses to one row.

Never stored: prompts, replies, tool names/inputs/outputs, file paths, cwd, emails, account/org UUIDs, raw session ids,
raw request ids, headers, credentials, raw telemetry bodies.

## 4. Summary interface (ledger → mod/CLI)

`token-ledger summary --json` prints, and the collector rewrites `summary.json` after every committed batch:

```json
{
  "schema": 1,
  "status": "ok | empty | stale | unavailable",
  "total": 12483910,
  "requests": 4210,
  "breakdown": { "input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0, "cacheWrite5m": 0, "cacheWrite1h": 0 },
  "firstRecordedAt": "2026-10-01T12:00:00.000Z",
  "updatedAt": "2026-11-10T09:00:00.000Z",
  "generatedAt": "2026-11-10T09:00:05.000Z",
  "sources": [ { "label": "laptop", "kind": "local|remote|cloud", "status": "reporting|silent|revoked|never",
                 "total": 0, "requests": 0, "firstAt": "…", "lastAt": "…" } ],
  "gaps": [ { "source": "laptop", "kind": "unsupported_format|partial_record|export_gap|unconnected|authority",
              "count": 3, "detail": "plain text, no paths or content" } ],
  "authority": [ { "scope": "laptop", "authoritative": "otel+transcript (request_id match)" } ]
}
```
- `status: empty` only when the ledger exists, is readable and holds zero records → render `0` (confirmed zero).
- Mod derives `stale` when `generatedAt` is older than 15 min **and** the collector health check fails.
- `unavailable` when no summary can be read → render `Total tracked tokens · unavailable`. Never render 0 for unknown.

Rendering (shared, `plugin/lib/format.mjs`, mirrored in mod):
- ok/empty: `Total tracked tokens · 12,483,910` (en-US grouping, middle dot U+00B7)
- stale: `Total tracked tokens · 12,483,910 (stale · updated 3h ago)`
- unavailable: `Total tracked tokens · unavailable`

## 5. Collector HTTP API

Default bind `127.0.0.1:47318`. Non-loopback bind requires `--tls-cert/--tls-key` (HTTPS) else refuses to start.

| Method/path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/logs` | loopback: none; remote: ingest token | OTLP/HTTP JSON logs. Only `claude_code.api_request` records are used. Others ignored. |
| `POST /ingest/v1/records` | ingest token (`Authorization: Bearer tl_ing_…`) | normalized records from relays/imports (§3 fields, `rid` precomputed) |
| `GET /api/v1/summary` | loopback: none; remote: read token (`tl_read_…`) | §4 JSON |
| `GET /healthz` | none | `{ok:true,version}` only |

- Body cap 1 MiB (413). JSON only (415 otherwise). Max 5,000 records per request. Validate every record; invalid ones
  counted as gaps and never stored. Respond 2xx **only after** SQLite commit.
- Tokens: random 32 bytes base64url, stored as sha256 hash with label + scope (`ingest` | `read`) + revoked flag.
  Ingest tokens cannot read; read tokens cannot ingest. Revocation is immediate.
- An ingest token is bound to its source label; the server overrides `source` with the token's label.
- Logs: one line per event (`ts level msg counts`), never bodies, headers or tokens.

## 6. Sources

1. **Live OTel (authoritative for live data).** Installer adds to `~/.claude/settings.json` `env`:
   `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`,
   `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:47318/v1/logs`, `OTEL_LOGS_EXPORT_INTERVAL=5000`.
   Logs signal only: metrics/traces exporters the user already has stay untouched. If the user already has a logs
   exporter, see §8 coexistence.
2. **Transcript sync/import.** `token-ledger import --dry-run|--yes [--since]` reads `~/.claude/projects/**/*.jsonl`
   assistant entries with `message.usage` + `requestId`; one record per `requestId` (streamed lines repeat usage — take
   the last line per id). Unknown shapes → `unsupported_format` gap counts. `token-ledger sync` = incremental import
   (byte offsets stored per file hash-of-path) run at session start and stop so exports dropped while the collector was
   down are recovered.
3. **Relay (other computers / cloud).** `token-ledger pair join <code>` makes the local collector forward every committed
   record to the primary over HTTPS with its ingest token; an outbox table holds unacknowledged records (durable).
4. **Analytics API / org reports:** separate scope, not added to the total (see docs/COVERAGE.md).

## 7. CLI surface

```
token-ledger serve [--host --port --tls-cert --tls-key]   # foreground collector
token-ledger start | stop | status                          # detached collector management (pidfile)
token-ledger ensure                                         # start if not running; exit fast (<300ms when running)
token-ledger summary [--json] [--details]
token-ledger import --dry-run | --yes [--since ISO] [--projects DIR]
token-ledger sync
token-ledger export [--format json|csv] [--out FILE]
token-ledger erase --yes                                    # deletes ledger data (db, summary, outbox), keeps config
token-ledger source list | revoke <label> | add <label> --kind remote|cloud
token-ledger pair create <label> [--url https://…]          # prints one-time pairing code
token-ledger pair join <code>
token-ledger install [--yes] | upgrade | uninstall [--keep-data|--erase-data] | doctor | verify
token-ledger statusline wrap | unwrap | render              # optional, composable status-line segment
token-ledger demo load                                      # synthetic data into a separate TOKEN_LEDGER_HOME
```
Exit codes: 0 ok, 1 error, 2 usage, 3 not installed/unavailable.

## 8. Install rules

- Idempotent. Backup `settings.json` to `backups/settings.<ts>.json` before the first change. Record each key added in
  `install-manifest.json`; uninstall removes only those keys, and only if still holding our values.
- Existing `OTEL_*`/telemetry: metrics/traces untouched. Existing logs exporter to another endpoint: store it as
  `forward.logsEndpoint` (+ headers via `otelHeadersHelper` left in place) and point Claude Code at the collector, which
  forwards the raw OTLP body unchanged after commit (fan-out). Managed settings that pin telemetry: do not override;
  report `authority` gap and fall back to transcript sync.
- Existing `statusLine`: never replaced by default. `statusline wrap` stores the original command and runs it first,
  then appends ` · Token Ledger …`; `unwrap` restores it byte-for-byte.
- Existing plugins: untouched. Built-in `/usage`: preserved.

## 9. Acceptance tests (owner: verification; manager reruns)

A1 clean profile (`HOME`/`CLAUDE_CONFIG_DIR` temp) → marketplace add + plugin install from release-equivalent checkout →
   setup → real `claude -p` request → record in ledger → `/token-ledger` shows non-zero total.
A2 setup twice: settings.json identical after second run, no duplicate env/hook/statusline; upgrade; uninstall keep/erase.
A3 two sources (local + paired relay over HTTPS self-signed) sum into one total; per-source rows in details.
A4 replay the same OTLP body 3×, restart collector, import same transcripts 2×, overlapping live+import → total unchanged.
A5 delete transcript after capture → total unchanged; `erase --yes` → status empty/0 confirmed.
A6 privacy: grep db dump, logs, exports, release tarball for prompt canary, tool payload canary, token strings → none.
   Unauthorized ingest/read → 401; ingest token cannot read; read token cannot ingest; revoked → 401; >1 MiB → 413.
A7 setup path under PowerShell 7 (pwsh) and bash.
