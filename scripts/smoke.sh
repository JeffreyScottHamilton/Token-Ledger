#!/usr/bin/env bash
# Smoke test (bash): install twice, post a sample OTLP body, check the total, uninstall, check settings restored.
# Uses temp HOME / CLAUDE_CONFIG_DIR / TOKEN_LEDGER_HOME only. Exit code non-zero on any failure.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CLI="$ROOT/plugin/bin/token-ledger.mjs"
NODE=${NODE:-node}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tl-smoke.XXXXXX")
export HOME="$TMP/home" USERPROFILE="$TMP/home"
export CLAUDE_CONFIG_DIR="$TMP/home/.claude" TOKEN_LEDGER_HOME="$TMP/data"
export TOKEN_LEDGER_MANAGED_SETTINGS_DIR="$TMP/managed"
export TOKEN_LEDGER_PORT=${TOKEN_LEDGER_PORT:-$((47400 + RANDOM % 500))}
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
SAMPLE="$ROOT/demo/otlp-sample.json"
[ -f "$SAMPLE" ] || SAMPLE="$ROOT/tests/install/fixtures/otlp-sample.json"
tl() { "$NODE" --no-warnings "$CLI" "$@"; }
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
cleanup() { tl stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
hash_of() { "$NODE" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
total() { tl summary --json | "$NODE" -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const s=JSON.parse(b);process.stdout.write(s.status+" "+s.total+" "+s.requests)})'; }

mkdir -p "$CLAUDE_CONFIG_DIR"
printf '{\n  "theme": "dark",\n  "env": {\n    "KEEP_ME": "1",\n    "OTEL_METRICS_EXPORTER": "none"\n  },\n  "statusLine": {\n    "type": "command",\n    "command": "echo mine"\n  }\n}\n' > "$SETTINGS"
cp "$SETTINGS" "$TMP/original.json"
ORIG=$(hash_of "$SETTINGS")
SKIP=""
command -v claude >/dev/null 2>&1 || SKIP="--skip-claude-check"

echo "== install (1)"
tl install --yes --no-import $SKIP
H1=$(hash_of "$SETTINGS")
[ "$H1" != "$ORIG" ] || fail "install did not change settings.json"
grep -q '"KEEP_ME": "1"' "$SETTINGS" || fail "existing env key lost"
grep -q '"command": "echo mine"' "$SETTINGS" || fail "statusLine changed"
grep -q "http://127.0.0.1:$TOKEN_LEDGER_PORT/v1/logs" "$SETTINGS" || fail "logs endpoint missing"

echo "== install (2)"
tl install --yes --no-import $SKIP >/dev/null
H2=$(hash_of "$SETTINGS")
[ "$H1" = "$H2" ] || fail "second install changed settings.json ($H1 != $H2)"
[ "$(ls "$TOKEN_LEDGER_HOME/backups" | wc -l | tr -d ' ')" = "1" ] || fail "expected exactly one settings backup"

echo "== verify"
tl verify

echo "== post sample OTLP logs"
post() { "$NODE" -e '
const fs=require("fs"),http=require("http");const body=fs.readFileSync(process.argv[2]);
const r=http.request({host:"127.0.0.1",port:+process.argv[1],path:"/v1/logs",method:"POST",headers:{"content-type":"application/json","content-length":body.length}},x=>{x.resume();x.on("end",()=>process.exit(x.statusCode>=200&&x.statusCode<300?0:1))});
r.on("error",()=>process.exit(1));r.end(body);' "$TOKEN_LEDGER_PORT" "$SAMPLE"; }
post || fail "collector rejected the sample"
sleep 2
read -r STATUS TOTAL REQS <<<"$(total)"
echo "status=$STATUS total=$TOTAL requests=$REQS"
[ "$STATUS" = "ok" ] || fail "summary status is $STATUS"
[ "$TOTAL" -gt 0 ] || fail "total is not positive"
post || fail "replay rejected"
sleep 2
read -r _ TOTAL2 _ <<<"$(total)"
[ "$TOTAL" = "$TOTAL2" ] || fail "replay changed the total ($TOTAL -> $TOTAL2)"
tl summary

echo "== statusline wrap/unwrap"
tl statusline wrap >/dev/null
OUT=$(echo '{}' | tl statusline render)
case "$OUT" in "mine · Total tracked tokens · "*) ;; *) fail "statusline render gave: $OUT" ;; esac
tl statusline unwrap >/dev/null
[ "$(hash_of "$SETTINGS")" = "$H1" ] || fail "statusline unwrap not byte-exact"

echo "== uninstall --erase-data"
tl uninstall --erase-data
[ "$(hash_of "$SETTINGS")" = "$ORIG" ] || fail "settings.json not restored to the original bytes"
cmp -s "$SETTINGS" "$TMP/original.json" || fail "settings.json differs from original"
[ ! -e "$TOKEN_LEDGER_HOME" ] || fail "data dir still exists"
echo "SMOKE OK (bash) total=$TOTAL"
