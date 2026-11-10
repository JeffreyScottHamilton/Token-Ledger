# Coverage

What Claude Token Ledger counts, and how sure we are. "Total tracked tokens" is the sum over the sources marked
*covered* that you have connected. Anything else is listed here so the total is never mistaken for more than it is.

Evidence levels: **verified live** (a real request was observed end to end), **fixture** (tested against recorded or
synthetic data in the test suite), **unverified** (designed for, not yet observed).


| Source | Status | How it is counted | Evidence |
| --- | --- | --- | --- |
| Claude Code terminal CLI (`claude`, `claude -p`) | Covered | Live OpenTelemetry logs + transcript sync; same `request_id`, counted once | Verified live (Linux) |
| Subagents and retries | Covered | Each actual API request has its own id and is counted once | Verified live (main + subagent, 3 requests) |
| Claude Desktop — Code tab (local sessions) | Covered (same settings and transcripts as the CLI) | Live OTel + transcript sync | Unverified |
| VS Code / JetBrains extension | Covered (same settings and transcripts as the CLI) | Live OTel + transcript sync | Unverified |
| Another computer | Covered after pairing | Relay over HTTPS with an ingest token; durable outbox | Fixture (self-signed HTTPS, one machine) |
| Claude Code on the web / cloud environments | Covered only with a reachable HTTPS collector and a network secret | OTel logs sent to the primary; no local transcripts | Unverified (no public collector available) |
| Amazon Bedrock / Google Vertex AI / Foundry as provider | Covered if the telemetry event carries a `request_id` | Live OTel; records without an id are tallied as `partial_record` gaps, not counted | Unverified |
| Organization-managed telemetry (managed settings pin `OTEL_EXPORTER_OTLP_*`) | Partial | Transcript sync only; reported as an `authority` gap | Fixture (unit tests) |
| claude.ai chats (web, desktop chat, mobile) | **Not covered** | No local usage data is exposed | n/a |
| Cowork sessions | **Not covered** | Not measured | n/a |
| Direct Anthropic API / Agent SDK apps outside Claude Code | **Not covered** | Only Claude Code telemetry and transcripts are read | n/a |
| Anthropic Analytics / Usage & Cost APIs, organization reports | Separate scope, **not added** to the total | Would double count and needs an admin key | n/a |

## What the number means

- `total = uncached input + output + cache writes + cache reads`. The 5-minute / 1-hour cache-write figures are a
  breakdown of cache writes and are never added again.
- One row per API request. The same request seen live and again in a transcript collapses to one row.
- It is not a bill and not your plan's usage limit: plans weigh models and cache tokens differently, and include
  usage this tool cannot see (for example claude.ai chats).

## Known gaps

- Requests made while the collector was down are recovered from transcripts on the next sync, unless the transcript
  was deleted first (Claude Code removes old transcripts after its retention period).
- History before the first import depends on which transcripts still exist on disk.
- Gaps the ledger can detect are counted and shown under *Coverage gaps* in `/token-ledger details`.
