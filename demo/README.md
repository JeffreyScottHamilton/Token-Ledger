# Demo data (synthetic)

Everything in this folder is **synthetic**. No file here contains real usage, prompts, replies or identifiers.

| File | What it is |
| --- | --- |
| `synthetic-records.json` | 200 normalized ledger records (fake `rid`s starting `de300000`, sources `demo-laptop` and `demo-cloud`, origin `demo`). They sum to exactly **12,483,910** tokens, so the demo shows the canonical counter `Total tracked tokens · 12,483,910`. |
| `otlp-sample.json` | A synthetic OTLP/HTTP JSON logs body shaped like Claude Code 2.1.321 telemetry (two `claude_code.api_request` events). |
| `transcript-sample.jsonl` | A synthetic transcript fragment: one response written as two content-block lines with identical usage (counts once). |

## Load the demo

Use a **separate** data home so demo records never mix with your real ledger:

```sh
TOKEN_LEDGER_HOME=/tmp/tl-demo node plugin/bin/token-ledger.mjs demo load --yes
TOKEN_LEDGER_HOME=/tmp/tl-demo node plugin/bin/token-ledger.mjs summary --details
```

`demo load` writes into whatever `TOKEN_LEDGER_HOME` is current and refuses without `--yes`. Remove the demo with
`TOKEN_LEDGER_HOME=/tmp/tl-demo node plugin/bin/token-ledger.mjs erase --yes` (or delete the folder).

## Try the collector with the OTLP sample

```sh
TOKEN_LEDGER_HOME=/tmp/tl-demo TOKEN_LEDGER_PORT=47399 node plugin/bin/token-ledger.mjs start
curl -s -X POST -H 'Content-Type: application/json' --data-binary @demo/otlp-sample.json http://127.0.0.1:47399/v1/logs
TOKEN_LEDGER_HOME=/tmp/tl-demo TOKEN_LEDGER_PORT=47399 node plugin/bin/token-ledger.mjs stop
```

Posting the same body again does not change the total (records are de-duplicated by request id).
