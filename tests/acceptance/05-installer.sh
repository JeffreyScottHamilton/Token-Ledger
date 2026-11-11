#!/usr/bin/env bash
# Check 5: installer idempotence / restore (bash)
. "$(dirname "$0")/common.sh"
fresh c5 47410
S="$CLAUDE_CONFIG_DIR/settings.json"
# 4-space indent, unusual key order, no trailing newline, unicode, existing statusLine, metrics exporter, other plugin
printf '{\n    "model": "opus",\n    "permissions": {"allow": ["Bash(ls:*)"], "deny": []},\n    "statusLine": {"type": "command", "command": "echo MY-STATUS \\u00e9"},\n    "env": {\n        "OTEL_METRICS_EXPORTER": "otlp",\n        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://127.0.0.1:9/v1/metrics",\n        "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "grpc",\n        "MY_VAR": "1"\n    },\n    "enabledPlugins": {"other-plugin@some-market": true},\n    "zzz": [1, 2,   3]\n}' > "$S"
cp "$S" "$V/c5/orig.json"; sha256sum "$S"
# old transcript predating setup
P="$CLAUDE_CONFIG_DIR/projects/-p"; mkdir -p "$P"
mk() { echo "{\"type\":\"assistant\",\"timestamp\":\"$2\",\"sessionId\":\"s\",\"requestId\":\"$1\",\"message\":{\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":$3,\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}"; }
{ mk req_OLD1 2026-09-01T00:00:00.000Z 1000; mk req_OLD2 2026-10-01T00:00:00.000Z 2000; echo '{"type":"assistant","message":{}}'; } > "$P/old.jsonl"
echo "== install #1 (--no-import so the history question is isolated)"
$CLI install --yes --skip-claude-check --no-import; echo "exit=$?"
cp "$S" "$V/c5/after1.json"; sha256sum "$S"
echo "== diff orig -> after1"; diff "$V/c5/orig.json" "$V/c5/after1.json"
echo "== install #2"; $CLI install --yes --skip-claude-check --no-import | grep -E 'Settings|Collector'; sha256sum "$S"; cmp "$S" "$V/c5/after1.json" && echo "SECOND RUN BYTE-IDENTICAL"
sha256sum "$TOKEN_LEDGER_HOME/install-manifest.json" "$TOKEN_LEDGER_HOME/config.json"
$CLI install --yes --skip-claude-check --no-import >/dev/null; sha256sum "$TOKEN_LEDGER_HOME/install-manifest.json" "$TOKEN_LEDGER_HOME/config.json"
echo "== existing values preserved?"; node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1])),b=JSON.parse(require("fs").readFileSync(process.argv[2]));for(const k of Object.keys(a)){if(k!=="env")console.log(k,JSON.stringify(a[k])===JSON.stringify(b[k]))}for(const k of Object.keys(a.env))console.log("env."+k,a.env[k]===b.env[k]);console.log("added env:",Object.keys(b.env).filter(k=>!(k in a.env)).join(","));console.log("added top:",Object.keys(b).filter(k=>!(k in a)).join(","))' "$V/c5/orig.json" "$S"
echo "== sync baseline: old transcripts not imported by sync"
$CLI sync; $CLI summary
mk req_NEW1 "$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%S.000Z)" 7 >> "$P/old.jsonl"
$CLI sync; echo "after new line + sync: $($CLI summary) (expect 7)"
$CLI import --dry-run
$CLI import --yes | tail -3; echo "after import --yes: $($CLI summary) (expect 3,007)"
$CLI doctor | head -30; $CLI verify; echo "verify exit=$?"
echo "== uninstall --keep-data"
$CLI uninstall --keep-data --yes; echo "exit=$?"
cmp "$S" "$V/c5/orig.json" && echo "SETTINGS RESTORED BYTE-EXACT" || diff "$V/c5/orig.json" "$S"
ls -la "$TOKEN_LEDGER_HOME"; echo "ledger kept: $($CLI summary)"; $CLI status
echo "== reinstall"; $CLI install --yes --skip-claude-check --no-import | grep -E 'Settings|Collector'; cmp "$S" "$V/c5/after1.json" && echo "REINSTALL == after1"; echo "$($CLI summary)"
echo "== uninstall --erase-data"; $CLI uninstall --erase-data --yes; echo "exit=$?"
cmp "$S" "$V/c5/orig.json" && echo "SETTINGS RESTORED BYTE-EXACT"; ls -la "$TOKEN_LEDGER_HOME" 2>&1; $CLI summary; echo "summary exit=$?"
pgrep -af "token-ledger.mjs serve" | grep -c . ; curl -s -m 1 http://127.0.0.1:47410/healthz; echo " <- healthz after uninstall (expect empty)"
